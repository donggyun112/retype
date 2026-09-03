import * as vscode from 'vscode';
import { startServer } from './server';
import { cancelActive, ghostProvider, hasActive, whyLensProvider } from './ghost';
import { panel } from './panel';

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
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, ghostProvider),
    vscode.commands.registerCommand('retype.cancel', cancelActive),
    vscode.commands.registerCommand('retype.askViewport', askViewport),
    ...panel(context, port)
  );

  // e2e 테스트가 MCP 클라이언트로 붙을 때 쓴다
  return { port, hasActive };
}

async function askViewport() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const start = Math.min(...editor.visibleRanges.map((r) => r.start.line));
  const end = Math.max(...editor.visibleRanges.map((r) => r.end.line));
  const file = vscode.workspace.asRelativePath(editor.document.uri);

  // Claude Code: 보이는 구간을 선택해 @-멘션으로 입력창에 넣고 포커스를 옮긴다.
  if (vscode.extensions.getExtension('anthropic.claude-code')) {
    const prev = editor.selection;
    editor.selection = new vscode.Selection(start, 0, end, editor.document.lineAt(end).text.length);
    try {
      await vscode.commands.executeCommand('claude-vscode.insertAtMention');
      await vscode.commands.executeCommand('claude-vscode.focus');
      return;
    } catch {
      // 아래 후보로
    } finally {
      editor.selection = prev;
    }
  }

  // Copilot Chat: 질문 머리말을 채워 연다.
  const query = `#file:${file} ${start + 1}-${end + 1}번 줄 — `;
  if (vscode.extensions.getExtension('github.copilot-chat')) {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query,
        isPartialQuery: true,
      });
      return;
    } catch {
      // 아래로
    }
  }

  await vscode.env.clipboard.writeText(query);
  vscode.window.showInformationMessage(
    `retype: 채팅을 열지 못했다. 질문 머리말을 클립보드에 넣었다 — ${file} ${start + 1}-${end + 1}`
  );
}

export function deactivate() {}
