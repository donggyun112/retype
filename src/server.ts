import * as http from 'node:http';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { propose } from './ghost';

function timeoutMs() {
  const min = vscode.workspace.getConfiguration('retype').get<number>('timeoutMinutes', 10);
  return Math.max(1, min) * 60_000;
}

// 채팅 패널(webview)에 포커스가 가면 activeTextEditor가 비어버린다.
// 마지막으로 활성이었던 텍스트 편집기를 기억해서, 아직 보이면 그걸 쓴다.
let lastEditor = vscode.window.activeTextEditor;
const trackEditor = vscode.window.onDidChangeActiveTextEditor((e) => {
  if (e) lastEditor = e;
});

function currentEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) return active;
  const visible = vscode.window.visibleTextEditors;
  return (
    visible.find((e) => e.document.uri.toString() === lastEditor?.document.uri.toString()) ??
    visible[0]
  );
}

async function editorFor(file?: string): Promise<vscode.TextEditor> {
  if (!file) {
    const editor = currentEditor();
    if (!editor) throw new Error('열려 있는 편집기가 없다. file을 넘기거나 파일을 열어라.');
    return editor;
  }
  const uri = file.startsWith('/')
    ? vscode.Uri.file(file)
    : vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd()),
        file
      );
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: false });
}

/** 줄 시작 들여쓰기만 파일 설정(스페이스/탭, 탭 폭)으로 바꾼다. 줄 안쪽 공백은 안 건드린다. */
export function normalizeIndent(text: string, opts: vscode.TextEditorOptions): string {
  const size = typeof opts.tabSize === 'number' ? opts.tabSize : 4;
  const spaces = opts.insertSpaces !== false;
  return text
    .split('\n')
    .map((line) => {
      const m = /^[ \t]*/.exec(line)![0];
      if (!m) return line;
      let width = 0;
      for (const ch of m) width = ch === '\t' ? width + size - (width % size) : width + 1;
      const indent = spaces ? ' '.repeat(width) : '\t'.repeat(Math.floor(width / size)) + ' '.repeat(width % size);
      return indent + line.slice(m.length);
    })
    .join('\n');
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'retype', version: '0.1.0' });

  server.registerTool(
    'propose',
    {
      title: '따라쓰기 제안',
      description:
        '코드를 직접 쓰지 말고 이 툴로 제안해라. 편집기에 회색으로 뜨고 사람이 직접 타이핑해야 확정된다. ' +
        '사람이 다 칠 때까지 이 호출은 돌아오지 않는다. 돌아오면 그게 한 덩어리가 끝났다는 신호이니, ' +
        '그 자리에서 다음 스텝을 제안하거나 물어봐라. 한 번에 한 덩어리(길어야 십여 줄)만 제안해라. ' +
        '들여쓰기는 파일 기준 절대값으로 써라(앞줄이 아니라 파일 전체 구조를 보고). 탭/스페이스는 알아서 맞춘다. ' +
        '이미 파일에 있는 코드를 다시 제안하면 {typed:false, reason:"already_present"}가 돌아온다 — 그땐 다음으로 넘어가라.',
      inputSchema: {
        text: z.string().describe('사람이 따라 칠 코드. 들여쓰기는 파일 기준 절대값.'),
        why: z.string().describe('왜 이렇게 쓰는지 한 줄. 고스트 위에 그대로 뜬다.'),
        file: z.string().optional().describe('대상 파일. 생략하면 지금 열린 파일.'),
        line: z
          .number()
          .int()
          .optional()
          .describe('1-based 줄 번호. 그 줄 시작에 쓴다. 생략하면 지금 커서 자리.'),
      },
    },
    async ({ text, why, file, line }) => {
      const editor = await editorFor(file);
      let anchorPos = editor.selection.active;
      if (line !== undefined) {
        const idx = Math.max(0, Math.min(line - 1, editor.document.lineCount - 1));
        anchorPos = new vscode.Position(idx, 0);
        editor.selection = new vscode.Selection(anchorPos, anchorPos);
        editor.revealRange(new vscode.Range(anchorPos, anchorPos));
      }
      const anchor = editor.document.offsetAt(anchorPos);
      const doc = editor.document;

      // 탭/스페이스는 파일 설정을 따른다. 사람이 이걸 신경 쓸 이유가 없다.
      text = normalizeIndent(text, editor.options);

      // 이미 있는 코드를 다시 제안했으면 치게 하지 않는다.
      const ahead = doc.getText(new vscode.Range(doc.positionAt(anchor), doc.positionAt(anchor + text.length + 64)));
      if (text.trim() && ahead.replace(/\s+/g, ' ').trim().startsWith(text.replace(/\s+/g, ' ').trim())) {
        const result = { typed: false, reason: 'already_present' };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      // 앵커가 줄 중간(앞에 코드가 있음)인데 제안이 줄바꿈 없이 시작하면, 사람은 어차피 Enter부터
      // 치니까 제안 앞에 \n을 붙여 맞춘다. 단 한 줄짜리 비들여쓰기 제안은 같은 줄에 이어 쓰는 걸로 본다.
      const before = doc.lineAt(anchorPos.line).text.slice(0, anchorPos.character);
      const midLine = before.trim().length > 0;
      const wantsOwnLine = /^[ \t]/.test(text) || text.includes('\n');
      const target = midLine && wantsOwnLine && !text.startsWith('\n') ? '\n' + text : text;
      const result = await propose(editor, anchor, target, why, timeoutMs());
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'read_viewport',
    {
      title: '지금 보이는 구간',
      description:
        '사람이 지금 화면에서 보고 있는 파일과 줄 범위, 그 본문을 읽는다. ' +
        '"이 부분", "여기" 같은 말이 나오면 이걸 먼저 불러라.',
      inputSchema: {},
    },
    async () => {
      const editor = currentEditor();
      if (!editor) {
        return { content: [{ type: 'text', text: '열려 있는 편집기가 없다.' }], isError: true };
      }
      const ranges = editor.visibleRanges;
      const start = Math.min(...ranges.map((r) => r.start.line));
      const end = Math.max(...ranges.map((r) => r.end.line));
      const range = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
      const payload = {
        file: vscode.workspace.asRelativePath(editor.document.uri),
        language: editor.document.languageId,
        startLine: start + 1,
        endLine: end + 1,
        selection: editor.selection.isEmpty ? null : editor.document.getText(editor.selection),
        text: editor.document.getText(range),
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
  );

  return server;
}

/** localhost에 MCP(Streamable HTTP) 엔드포인트를 띄우고 포트를 돌려준다. */
export function startServer(): Promise<{ port: number; dispose: () => void }> {
  const httpServer = http.createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // 상태를 안 들고 있으니 GET(SSE)·DELETE(세션 종료)는 받을 게 없다.
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      // 상태 없는 처리: 요청마다 새로 만든다. propose가 오래 물고 있어도 서로 안 막힌다.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      }
    });
  });

  // 사람이 다 칠 때까지 기다리는 게 정상이므로 소켓을 끊지 않는다.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.timeout = 0;

  // 고정 포트면 창 밖의 클라이언트(Claude Code 등)가 주소를 미리 알 수 있다.
  // 다른 창이 이미 잡고 있으면 랜덤으로 물러난다.
  const wanted = vscode.workspace.getConfiguration('retype').get<number>('port', 0);
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeAllListeners('error');
        const addr = httpServer.address();
        if (typeof addr === 'string' || addr === null) reject(new Error('포트를 못 잡았다'));
        else resolve(addr.port);
      });
    });

  return listen(wanted)
    .catch((err) => {
      if (wanted === 0 || err?.code !== 'EADDRINUSE') throw err;
      vscode.window.showWarningMessage(
        `retype: ${wanted} 포트를 다른 창이 쓰고 있어 랜덤 포트로 띄웠다. 창 밖 클라이언트는 이 창에 못 붙는다.`
      );
      return listen(0);
    })
    .then((port) => ({
      port,
      dispose: () => {
        trackEditor.dispose();
        httpServer.close();
      },
    }));
}
