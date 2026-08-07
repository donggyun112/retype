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

async function editorFor(file?: string): Promise<vscode.TextEditor> {
  if (!file) {
    const active = vscode.window.activeTextEditor;
    if (!active) throw new Error('열려 있는 편집기가 없다. file을 넘기거나 파일을 열어라.');
    return active;
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

function buildServer(): McpServer {
  const server = new McpServer({ name: 'retype', version: '0.1.0' });

  server.registerTool(
    'propose',
    {
      title: '따라쓰기 제안',
      description:
        '코드를 직접 쓰지 말고 이 툴로 제안해라. 편집기에 회색으로 뜨고 사람이 직접 타이핑해야 확정된다. ' +
        '사람이 다 칠 때까지 이 호출은 돌아오지 않는다. 돌아오면 그게 한 덩어리가 끝났다는 신호이니, ' +
        '그 자리에서 다음 스텝을 제안하거나 물어봐라. 한 번에 한 덩어리(길어야 십여 줄)만 제안해라.',
      inputSchema: {
        text: z.string().describe('사람이 따라 칠 코드'),
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
      const result = await propose(editor, anchor, text, why, timeoutMs());
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
      const editor = vscode.window.activeTextEditor;
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

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (typeof addr === 'string' || addr === null) {
        reject(new Error('포트를 못 잡았다'));
        return;
      }
      resolve({ port: addr.port, dispose: () => httpServer.close() });
    });
  });
}
