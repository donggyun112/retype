import * as vscode from 'vscode';
import { startServer } from './server';
import { cancelActive, whyLensProvider } from './ghost';

export async function activate(context: vscode.ExtensionContext) {
  const { port, dispose } = await startServer();
  context.subscriptions.push({ dispose });

  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('retype', {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: async () => [
        new vscode.McpHttpServerDefinition(
          'retype',
          vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`),
          {},
          '0.1.0'
        ),
      ],
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: '*' }, whyLensProvider),
    vscode.commands.registerCommand('retype.cancel', cancelActive),
    vscode.commands.registerCommand('retype.askViewport', askViewport)
  );
}

async function askViewport() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const start = Math.min(...editor.visibleRanges.map((r) => r.start.line)) + 1;
  const end = Math.max(...editor.visibleRanges.map((r) => r.end.line)) + 1;
  const file = vscode.workspace.asRelativePath(editor.document.uri);
  const query = `#file:${file} ${start}-${end}번 줄 — `;

  // 채팅을 열어 질문을 채워넣는다. 이 커맨드가 인자를 안 받는 환경이면 클립보드로 넘긴다.
  const opened = await tryChatOpen(query);
  if (opened) return;

  await vscode.env.clipboard.writeText(query);
  vscode.window.showInformationMessage(
    `retype: 채팅을 열지 못했다. 질문 머리말을 클립보드에 넣었다 — ${file} ${start}-${end}`
  );
}

async function tryChatOpen(query: string): Promise<boolean> {
  for (const cmd of ['workbench.action.chat.open', 'workbench.action.chat.openAgent']) {
    try {
      await vscode.commands.executeCommand(cmd, { query, isPartialQuery: true });
      return true;
    } catch {
      // 다음 후보로
    }
  }
  return false;
}

export function deactivate() {}
