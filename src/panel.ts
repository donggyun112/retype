// 커서 줄 밑에 붙는 인라인 패널. 댓글 위젯(vscode.comments)을 빌려 쓴다.
// claude에게 묻는 입력창 + 답 스레드.
import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

const RULES =
  '코드를 쓸 때는 Edit/Write 대신 retype의 propose(text, why)로 제안한다. 한 번에 한 덩어리(길어야 십여 줄). ' +
  'propose가 돌아오면 그 자리에서 다음 덩어리를 제안한다. "여기"·"이 부분"은 read_viewport()로 읽는다.';

const controller = vscode.comments.createCommentController('retype', 'retype');
controller.commentingRangeProvider = {
  provideCommentingRanges: (doc) => [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)],
};
controller.options = { prompt: 'claude에게 (⌘⏎)', placeHolder: '여기에 뭘 할까' };

/** 살아 있는 스레드와 그 에이전트 세션. 이어 물으면 resume. 에이전트를 바꾸면 세션은 새로. workspaceState에 저장한다. */
const threads = new Map<vscode.CommentThread, { session?: string; agent?: string }>();
let running: ChildProcess | null = null;
const out = vscode.window.createOutputChannel('retype');

type Who = 'me' | 'claude' | 'codex';
let icons: Record<Who, vscode.Uri>;
let store: vscode.Memento;
/** 이 창의 retype MCP 포트. claude -p에 --mcp-config로 넘겨서 등록 절차 없이 붙인다. */
let mcpPort = 0;

type Saved = {
  uri: string;
  start: number;
  end: number;
  session?: string;
  agent?: string;
  comments: { who: Who; body: string; label?: string; ts: number }[];
};

export function panel(context: vscode.ExtensionContext, port: number): vscode.Disposable[] {
  mcpPort = port;
  icons = {
    me: vscode.Uri.joinPath(context.extensionUri, 'resources/me.svg'),
    claude: vscode.Uri.joinPath(context.extensionUri, 'resources/claude.svg'),
    codex: vscode.Uri.joinPath(context.extensionUri, 'resources/codex.svg'),
  };
  store = context.workspaceState;
  restore();
  return [
    controller,
    { dispose: () => running?.kill() },
    vscode.commands.registerCommand('retype.ask', () =>
      vscode.commands.executeCommand('workbench.action.addComment')
    ),
    vscode.commands.registerCommand('retype.submit', (r: vscode.CommentReply) => submit(r, claude)),
    vscode.commands.registerCommand('retype.submitCodex', (r: vscode.CommentReply) => submit(r, codex)),
    vscode.commands.registerCommand('retype.close', (t: vscode.CommentThread) => {
      threads.delete(t);
      t.dispose();
      save();
    }),
  ];
}

function save() {
  const list: Saved[] = [];
  for (const [t, meta] of threads) {
    list.push({
      uri: t.uri.toString(),
      start: t.range?.start.line ?? 0,
      end: t.range?.end.line ?? 0,
      session: meta.session,
      agent: meta.agent,
      comments: t.comments.map((c) => ({
        who: c.author.name === '나' ? 'me' : c.author.name === 'codex' ? 'codex' : 'claude',
        body: typeof c.body === 'string' ? c.body : c.body.value,
        label: c.label,
        ts: c.timestamp?.getTime() ?? Date.now(),
      })),
    });
  }
  store.update('threads', list);
}

function restore() {
  for (const s of store.get<Saved[]>('threads', [])) {
    const t = controller.createCommentThread(
      vscode.Uri.parse(s.uri),
      new vscode.Range(s.start, 0, s.end, 0),
      s.comments.map((c) => {
        const cm = comment(c.who, md(c.body), new Date(c.ts));
        cm.label = c.label;
        return cm;
      })
    );
    t.label = 'retype';
    t.canReply = true;
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    threads.set(t, { session: s.session, agent: s.agent });
  }
}

function comment(who: Who, body: string | vscode.MarkdownString, at = new Date()): vscode.Comment {
  return {
    author: { name: who === 'me' ? '나' : who, iconPath: icons[who] },
    body,
    mode: vscode.CommentMode.Preview,
    timestamp: at,
  };
}

function md(text: string) {
  const m = new vscode.MarkdownString(text);
  m.supportThemeIcons = true;
  return m;
}

async function submit(reply: vscode.CommentReply, agent: Agent) {
  const { thread, text } = reply;
  if (!text.trim()) return;
  // 위젯이 다시 그려지면 스크롤이 튀니까, 이미 맞는 값이면 안 건드린다
  if (thread.label !== 'retype') thread.label = 'retype';
  if (!thread.canReply) thread.canReply = true;
  if (thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) {
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }
  thread.comments = [...thread.comments, comment('me', text)];
  const meta = threads.get(thread) ?? {};
  threads.set(thread, meta);
  if (meta.agent !== agent.name) {
    meta.session = undefined; // 다른 에이전트의 세션은 못 잇는다
    meta.agent = agent.name;
  }
  save();

  const file = vscode.workspace.asRelativePath(thread.uri);
  const r = thread.range;
  const where = r
    ? `${file} ${r.start.line + 1}${r.end.line !== r.start.line ? `-${r.end.line + 1}` : ''}번 줄`
    : file;
  const resume = meta.session;
  const prompt = resume ? text : `${where}: ${text}`;
  const cwd = vscode.workspace.getWorkspaceFolder(thread.uri)?.uri.fsPath;

  const answer = comment(agent.name as Who, md('$(loading~spin) 생각 중'));
  thread.comments = [...thread.comments, answer];
  let acc = '';
  const say = (t: string) => {
    acc += (acc ? '\n\n' : '') + t;
    answer.body = md(acc);
    thread.comments = [...thread.comments];
  };

  // VS Code는 이 커맨드가 리턴해야 입력창을 비운다. 그러니 기다리지 말고 뒤에서 돌린다.
  void runAgent(agent, prompt, cwd, resume, {
    text: say,
    tool: (name, input) =>
      say(
        name === 'propose'
          ? `$(edit) **따라쓰기** — ${input.why ?? ''}`
          : `$(eye) 화면을 읽음`
      ),
    session: (id) => (meta.session = id),
    error: (m) => say(`$(error) **오류:** ${m}`),
  }).then(() => {
    // 끝났다고 state·label을 바꾸면 위젯이 다시 그려져 튄다. 마지막 say()가 곧 끝이다.
    if (!acc) say('$(circle-slash) 말 없이 끝남');
    save();
  });
}

type Hooks = {
  text: (t: string) => void;
  tool: (name: string, input: Record<string, any>) => void;
  session: (id: string) => void;
  error: (m: string) => void;
};

/** 에이전트별로 다른 것: 바이너리 후보, 인자, 이벤트 파싱. 나머지 실행 루프는 같다. */
type Agent = {
  name: string;
  candidates: () => string[];
  args: (prompt: string, resume: string | undefined) => string[];
  handle: (msg: any, on: Hooks) => void;
};

function setting(key: string) {
  const v = vscode.workspace.getConfiguration('retype').get<string>(key);
  return v ? [v] : [];
}

function mcpUrl() {
  return `http://127.0.0.1:${mcpPort}/mcp`;
}

const claude: Agent = {
  name: 'claude',
  // 순서: 사용자가 지정한 경로 → Claude Code 익스텐션이 들고 있는 바이너리(별도 설치 불필요) → PATH
  candidates: () => {
    const ext = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath;
    return [
      ...setting('claudePath'),
      ...(ext ? [`${ext}/resources/native-binary/claude`] : []),
      'claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ];
  },
  // --allowedTools는 가변 인자라 프롬프트가 뒤에 오면 삼킨다. 프롬프트가 먼저.
  args: (prompt, resume) => [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    RULES,
    '--mcp-config',
    JSON.stringify({ mcpServers: { retype: { type: 'http', url: mcpUrl() } } }),
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__retype__propose,mcp__retype__read_viewport',
    ...(resume ? ['--resume', resume] : []),
  ],
  // stream-json 한 줄. assistant 텍스트만 건진다. 코드는 propose로 이미 고스트에 떴다.
  handle: (msg, on) => {
    if (msg.session_id) on.session(msg.session_id);
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) on.text(block.text);
        if (block.type === 'tool_use') {
          on.tool(String(block.name).replace(/^mcp__retype__/, ''), block.input ?? {});
        }
      }
    } else if (msg.type === 'result' && msg.is_error) {
      on.error(String(msg.result ?? ''));
    }
  },
};

const codex: Agent = {
  name: 'codex',
  // 순서: 사용자 지정 → OpenAI(Codex) 익스텐션이 들고 있는 바이너리 → PATH
  candidates: () => {
    const ext = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
    let bundled: string[] = [];
    if (ext) {
      try {
        const bin = `${ext}/bin`;
        bundled = fs
          .readdirSync(bin)
          .map((d) => `${bin}/${d}/codex`)
          .filter((p) => fs.existsSync(p));
      } catch {
        // 없으면 그냥 PATH로
      }
    }
    return [...setting('codexPath'), ...bundled, 'codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  },
  // 시스템 프롬프트 옵션이 없어서 규칙을 프롬프트 앞에 붙인다. read-only 샌드박스라 파일을 못 고치니
  // propose를 안 쓸 도리가 없다. 전역 옵션은 resume 서브커맨드 앞에 와야 한다.
  args: (prompt, resume) => [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-c',
    `mcp_servers.retype.url="${mcpUrl()}"`,
    '-c',
    'mcp_servers.retype.default_tools_approval_mode="approve"',
    ...(resume ? ['resume', resume] : []),
    `${RULES}\n\n${prompt}`,
  ],
  handle: (msg, on) => {
    if (msg.type === 'thread.started' && msg.thread_id) on.session(msg.thread_id);
    const item = msg.item;
    if (msg.type === 'item.completed' && item?.type === 'agent_message' && item.text?.trim()) {
      on.text(item.text);
    } else if (msg.type === 'item.started' && item?.type === 'mcp_tool_call') {
      on.tool(String(item.tool), item.arguments ?? {});
    } else if (msg.type === 'item.completed' && item?.type === 'mcp_tool_call' && item.error) {
      on.error(String(item.error.message ?? item.error));
    } else if (msg.type === 'turn.failed' || msg.type === 'error') {
      on.error(String(msg.error?.message ?? msg.message ?? msg.type));
    }
  },
};

/** 에이전트를 백그라운드로 돌린다. 코드는 고스트로 오고, 말은 hooks.text로 온다. */
function runAgent(
  agent: Agent,
  prompt: string,
  cwd: string | undefined,
  resume: string | undefined,
  on: Hooks
) {
  running?.kill();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.text = `$(sync~spin) ${agent.name}`;
  status.tooltip = prompt;
  status.show();

  const candidates = agent.candidates();
  const args = agent.args(prompt, resume);
  const handle = (line: string) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    agent.handle(msg, on);
  };

  return new Promise<void>((resolve) => {
    const finish = (child: ChildProcess) => {
      if (running === child) running = null;
      status.dispose();
      resolve();
    };
    const start = (i: number) => {
      const child = spawn(candidates[i], args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      running = child;
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) handle(l);
      });
      child.stderr.on('data', (c) => out.append(String(c)));
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' && i + 1 < candidates.length) return start(i + 1);
        on.error(`${agent.name} 실행 실패: ${err.message} — retype.${agent.name}Path 설정을 확인해라.`);
        finish(child);
      });
      child.on('close', (code) => {
        // 새 요청이 죽인 거면 조용히. 상태바는 어쨌든 치운다.
        if (running === child && code) on.error(`${agent.name} 종료 코드 ${code}`);
        finish(child);
      });
    };
    start(0);
  });
}
