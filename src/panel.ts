// 커서 줄 밑에 붙는 인라인 패널. 댓글 위젯(vscode.comments)을 빌려 쓴다.
// claude에게 묻는 입력창 + 답 스레드.
import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';

const RULES =
  '코드를 쓸 때는 Edit/Write 대신 retype의 propose(text, why)로 제안한다. 한 번에 한 덩어리(길어야 십여 줄). ' +
  'propose가 돌아오면 그 자리에서 다음 덩어리를 제안한다. "여기"·"이 부분"은 read_viewport()로 읽는다.';

const controller = vscode.comments.createCommentController('retype', 'retype');
controller.commentingRangeProvider = {
  provideCommentingRanges: (doc) => [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)],
};
controller.options = { prompt: 'claude에게 (⌘⏎)', placeHolder: '여기에 뭘 할까' };

/** 살아 있는 스레드와 그 claude 세션. 이어 물으면 --resume. workspaceState에 저장한다. */
const threads = new Map<vscode.CommentThread, { session?: string }>();
let running: ChildProcess | null = null;
const out = vscode.window.createOutputChannel('retype');

let icons: { me: vscode.Uri; claude: vscode.Uri };
let store: vscode.Memento;

type Saved = {
  uri: string;
  start: number;
  end: number;
  session?: string;
  comments: { who: 'me' | 'claude'; body: string; label?: string; ts: number }[];
};

export function panel(context: vscode.ExtensionContext): vscode.Disposable[] {
  icons = {
    me: vscode.Uri.joinPath(context.extensionUri, 'resources/me.svg'),
    claude: vscode.Uri.joinPath(context.extensionUri, 'resources/claude.svg'),
  };
  store = context.workspaceState;
  restore();
  return [
    controller,
    { dispose: () => running?.kill() },
    vscode.commands.registerCommand('retype.ask', () =>
      vscode.commands.executeCommand('workbench.action.addComment')
    ),
    vscode.commands.registerCommand('retype.submit', submit),
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
      comments: t.comments.map((c) => ({
        who: c.author.name === '나' ? 'me' : 'claude',
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
    threads.set(t, { session: s.session });
  }
}

function comment(
  who: 'me' | 'claude',
  body: string | vscode.MarkdownString,
  at = new Date()
): vscode.Comment {
  return {
    author: { name: who === 'me' ? '나' : 'claude', iconPath: icons[who] },
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

async function submit(reply: vscode.CommentReply) {
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
  save();

  const file = vscode.workspace.asRelativePath(thread.uri);
  const r = thread.range;
  const where = r
    ? `${file} ${r.start.line + 1}${r.end.line !== r.start.line ? `-${r.end.line + 1}` : ''}번 줄`
    : file;
  const resume = meta.session;
  const prompt = resume ? text : `${where}: ${text}`;
  const cwd = vscode.workspace.getWorkspaceFolder(thread.uri)?.uri.fsPath;

  const answer = comment('claude', md('$(loading~spin) 생각 중'));
  thread.comments = [...thread.comments, answer];
  let acc = '';
  const say = (t: string) => {
    acc += (acc ? '\n\n' : '') + t;
    answer.body = md(acc);
    thread.comments = [...thread.comments];
  };

  // VS Code는 이 커맨드가 리턴해야 입력창을 비운다. 그러니 기다리지 말고 뒤에서 돌린다.
  void runClaude(prompt, cwd, resume, {
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

/** claude -p를 백그라운드로 돌린다. 코드는 고스트로 오고, 말은 hooks.text로 온다. */
function runClaude(prompt: string, cwd: string | undefined, resume: string | undefined, on: Hooks) {
  running?.kill();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.text = '$(sync~spin) claude';
  status.tooltip = prompt;
  status.show();

  const cfg = vscode.workspace.getConfiguration('retype');
  const candidates = [
    cfg.get<string>('claudePath', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  // --allowedTools는 가변 인자라 프롬프트가 뒤에 오면 삼킨다. 프롬프트가 먼저.
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    RULES,
    '--allowedTools',
    'mcp__retype__propose,mcp__retype__read_viewport',
    ...(resume ? ['--resume', resume] : []),
  ];

  // stream-json 한 줄. assistant 텍스트만 건진다. 코드는 propose로 이미 고스트에 떴다.
  const handle = (line: string) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
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
        on.error(`claude 실행 실패: ${err.message} — retype.claudePath 설정을 확인해라.`);
        finish(child);
      });
      child.on('close', (code) => {
        // 새 요청이 죽인 거면 조용히. 상태바는 어쨌든 치운다.
        if (running === child && code) on.error(`claude 종료 코드 ${code}`);
        finish(child);
      });
    };
    start(0);
  });
}
