import * as vscode from 'vscode';
import { match } from './match';

export type ProposeResult =
  | { typed: true; ms: number; mistakes: number }
  | { typed: false; reason: 'abandoned' | 'timeout' | 'cancelled' };

const ghostDeco = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorGhostText.foreground'),
    fontStyle: 'italic',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const mistakeDeco = vscode.window.createTextEditorDecorationType({
  textDecoration: 'underline wavy var(--vscode-editorError-foreground)',
  backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
});

/** 지금 진행 중인 따라쓰기. 한 번에 하나만 돈다. */
let active: Session | null = null;

/** why를 고스트 위 한 줄로 띄우기 위한 CodeLens 소스 */
const lensChanged = new vscode.EventEmitter<void>();

export const whyLensProvider: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: lensChanged.event,
  provideCodeLenses(document) {
    if (!active || active.doc.uri.toString() !== document.uri.toString()) return [];
    const line = Math.max(0, document.positionAt(active.anchor).line);
    return [
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: `✍️  ${active.why}`,
        command: '',
      }),
    ];
  },
};

class Session {
  readonly doc: vscode.TextDocument;
  readonly anchor: number;
  readonly target: string;
  readonly why: string;

  private readonly startedAt: number;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly settle: (r: ProposeResult) => void;
  private timer: NodeJS.Timeout;
  private readonly timeoutMs: number;
  private mistakes = 0;
  private wasMistaken = false;
  private done = false;
  private status: vscode.StatusBarItem;

  constructor(
    editor: vscode.TextEditor,
    anchor: number,
    target: string,
    why: string,
    timeoutMs: number,
    startedAt: number,
    settle: (r: ProposeResult) => void
  ) {
    this.doc = editor.document;
    this.anchor = anchor;
    this.target = target;
    this.why = why;
    this.timeoutMs = timeoutMs;
    this.startedAt = startedAt;
    this.settle = settle;

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.show();

    this.timer = setTimeout(() => this.finish({ typed: false, reason: 'timeout' }), timeoutMs);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.doc.uri.toString()) this.render();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() === this.doc.uri.toString()) this.render();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed && ed.document.uri.toString() !== this.doc.uri.toString()) {
          this.finish({ typed: false, reason: 'abandoned' });
        }
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.toString() === this.doc.uri.toString()) {
          this.finish({ typed: false, reason: 'abandoned' });
        }
      })
    );

    vscode.commands.executeCommand('setContext', 'retype.active', true);
    lensChanged.fire();
    this.render();
  }

  cancel() {
    this.finish({ typed: false, reason: 'cancelled' });
  }

  private editor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === this.doc.uri.toString()
    );
  }

  private render() {
    if (this.done) return;
    const editor = this.editor();
    if (!editor) return;

    // 사람이 친 것 = 앵커부터 커서까지
    const cursor = editor.document.offsetAt(editor.selection.active);
    const typed =
      cursor > this.anchor
        ? editor.document.getText(
            new vscode.Range(
              editor.document.positionAt(this.anchor),
              editor.document.positionAt(cursor)
            )
          )
        : '';

    const state = match(this.target, typed);

    if (state.mistakeAt !== null && !this.wasMistaken) this.mistakes++;
    this.wasMistaken = state.mistakeAt !== null;

    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.finish({ typed: false, reason: 'timeout' }),
      this.timeoutMs
    );

    if (state.done) {
      this.finish({
        typed: true,
        ms: Date.now() - this.startedAt,
        mistakes: this.mistakes,
      });
      return;
    }

    // 회색: 남은 것의 첫 줄만 인라인으로. 나머지는 hover와 줄 수로 알린다.
    // 데코레이션에서 연속 공백이 뭉개지지 않게 non-breaking space로 그린다.
    const lines = state.remaining.split('\n');
    const head = lines[0].replace(/ /g, ' ') || (lines.length > 1 ? '⏎' : '');
    const tail = lines.length > 1 ? `  ⏎ +${lines.length - 1}줄` : '';
    const hover = new vscode.MarkdownString(
      `**왜:** ${this.why}\n\n\`\`\`\n${state.remaining}\n\`\`\``
    );

    const at = editor.document.positionAt(cursor);
    editor.setDecorations(ghostDeco, [
      {
        range: new vscode.Range(at, at),
        renderOptions: { after: { contentText: head + tail } },
        hoverMessage: hover,
      },
    ]);

    // 빨간 밑줄: 어긋나기 시작한 지점부터 커서까지
    editor.setDecorations(
      mistakeDeco,
      state.mistakeAt === null
        ? []
        : [
            new vscode.Range(
              editor.document.positionAt(this.anchor + state.mistakeAt),
              editor.document.positionAt(cursor)
            ),
          ]
    );

    this.status.text = `$(pencil) retype ${state.consumed}/${this.target.length}${
      state.mistakeAt !== null ? ' $(error)' : ''
    }`;
    this.status.tooltip = this.why;
  }

  private finish(result: ProposeResult) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    const editor = this.editor();
    editor?.setDecorations(ghostDeco, []);
    editor?.setDecorations(mistakeDeco, []);
    this.status.dispose();
    active = null;
    vscode.commands.executeCommand('setContext', 'retype.active', false);
    lensChanged.fire();
    this.settle(result);
  }
}

export function cancelActive() {
  active?.cancel();
}

export function hasActive() {
  return active !== null;
}

/** 회색 제안을 띄우고, 사람이 다 칠 때까지 기다린다. */
export function propose(
  editor: vscode.TextEditor,
  anchor: number,
  target: string,
  why: string,
  timeoutMs: number
): Promise<ProposeResult> {
  active?.cancel();
  const startedAt = Date.now();
  return new Promise((resolve) => {
    active = new Session(editor, anchor, target, why, timeoutMs, startedAt, resolve);
  });
}
