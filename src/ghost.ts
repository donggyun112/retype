import * as vscode from 'vscode';
import { match } from './match';

export type ProposeResult =
  | { typed: true; ms: number; mistakes: number }
  | { typed: false; reason: 'abandoned' | 'timeout' | 'cancelled' | 'already_present' };

const mistakeDeco = vscode.window.createTextEditorDecorationType({
  textDecoration: 'underline wavy var(--vscode-editorError-foreground)',
  backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
});

/** 지금 진행 중인 따라쓰기. 한 번에 하나만 돈다. */
let active: Session | null = null;

/**
 * 회색 = 인라인 완성. 여러 줄을 통째로 그려주는 유일한 공개 API다.
 * Tab·Cmd+→ 같은 수락 키는 package.json에서 retype.active일 때 원래 동작(들여쓰기·줄 끝)으로 돌려둔다.
 */
export const ghostProvider: vscode.InlineCompletionItemProvider = {
  provideInlineCompletionItems(document, position) {
    if (!active || active.doc.uri.toString() !== document.uri.toString()) return [];
    const offset = document.offsetAt(position);
    // 커서가 친 범위 밖(앞쪽이나 기존 코드 위)이면 회색도 없다
    if (offset < active.anchor || offset > active.end) return [];
    const typed = document.getText(new vscode.Range(document.positionAt(active.anchor), position));
    const state = match(active.target, typed);
    if (state.done || !state.remaining) return [];
    // 틀려도 남은 부분은 계속 보여준다. 틀린 글자는 빨간 밑줄이 알려준다.
    return [{ insertText: state.remaining, range: new vscode.Range(position, position) }];
  },
};

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
  /** 고스트가 시작하는 오프셋. 앞쪽이 편집되면 따라 움직인다. */
  anchor: number;
  /** 세션 시작 후 실제로 끼워넣은 텍스트의 끝. anchor..end 만 판정 대상이고, 그 뒤 기존 코드는 안 본다. */
  end: number;
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
    this.end = anchor;
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
        if (e.document.uri.toString() !== this.doc.uri.toString()) return;
        // 앵커 앞이 바뀌면(윗줄 삭제 등) 앵커·끝이 같이 밀린다. 앵커를 걸쳐 지우면 그 자리로 당긴다.
        // anchor..end 안의 편집은 끝을 늘리거나 줄인다. 끝 너머(기존 코드) 편집은 무시한다.
        for (const c of e.contentChanges) {
          const s = c.rangeOffset;
          const e2 = s + c.rangeLength;
          const delta = c.text.length - c.rangeLength;
          if (e2 < this.anchor || (e2 === this.anchor && c.rangeLength > 0)) {
            this.anchor += delta;
            this.end += delta;
          } else if (s < this.anchor) {
            this.anchor = s;
            this.end = s + c.text.length;
          } else if (s <= this.end) {
            this.end = e2 <= this.end ? this.end + delta : s + c.text.length;
          }
        }
        this.render();
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
    // 시작할 땐 커서가 가만히 있으니 한 번 찔러준다. 그 뒤론 타이핑마다 VS Code가 알아서 다시 묻는다.
    vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
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

    // 사람이 친 것 = 앵커부터 커서까지, 단 끼워넣은 범위(end)를 넘지 않는다.
    // 괄호 자동 닫힘은 end엔 들어가지만 커서 뒤라서 아직 친 걸로 안 친다.
    const cursor = Math.min(editor.document.offsetAt(editor.selection.active), this.end);
    const typed =
      cursor > this.anchor
        ? editor.document.getText(
            new vscode.Range(
              editor.document.positionAt(this.anchor),
              editor.document.positionAt(cursor)
            )
          )
        : '';

    // 줄 시작 들여쓰기는 사람이 아니라 retype이 맞춘다. Enter 직후 자동 들여쓰기가
    // 목표와 다르면(dedent 등) 그 공백을 목표 공백으로 갈아끼운다. 코드는 사람이, 공백은 편집기가.
    if (this.fixIndent(editor, typed, cursor)) return; // 편집이 이벤트를 다시 부른다

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

    // 회색은 ghostProvider가 그린다. 여기선 안 건드린다 — 매번 찌르면 자동완성 팝업이 밀린다.

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

  /** typed가 "…\n" + 공백으로 끝나고 커서가 그 끝이면, 공백을 목표 들여쓰기로 맞춘다. 편집했으면 true. */
  private fixIndent(editor: vscode.TextEditor, typed: string, cursor: number): boolean {
    const m = /(^|\n)([ \t]*)$/.exec(typed);
    if (!m) return false;
    if (m[1] === '' && this.anchor !== editor.document.offsetAt(editor.document.lineAt(editor.document.positionAt(this.anchor).line).range.start)) {
      return false; // 앵커가 줄 중간이면 앵커 직후 공백은 들여쓰기가 아니다
    }
    const typedIndent = m[2];
    const base = typed.slice(0, typed.length - typedIndent.length);
    const s = match(this.target, base);
    if (s.mistakeAt !== null || s.done) return false;
    const targetIndent = /^[ \t]*/.exec(this.target.slice(s.consumed))![0];
    if (targetIndent === typedIndent) return false;
    if (editor.document.offsetAt(editor.selection.active) !== cursor) return false;
    const from = editor.document.positionAt(cursor - typedIndent.length);
    const to = editor.document.positionAt(cursor);
    editor.edit((b) => b.replace(new vscode.Range(from, to), targetIndent), {
      undoStopBefore: false,
      undoStopAfter: false,
    });
    return true;
  }

  private finish(result: ProposeResult) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    const editor = this.editor();
    editor?.setDecorations(mistakeDeco, []);
    this.status.dispose();
    active = null;
    vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
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
