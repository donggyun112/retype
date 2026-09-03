# retype

AI가 코드를 적용하는 대신 **불러준다**. 사람이 직접 친다.

인지부채는 사람이 자기가 짜지 않은 코드를 떠안을 때 쌓인다. retype은 에이전트의 제안을
편집기에 회색으로만 띄우고, 사람이 실제로 타이핑해야 확정되게 만든다. Tab으로는 들어가지 않는다.

## 어떻게 도나

```
채팅 패널 (Copilot agent mode 등 — MCP 클라이언트)
   │  MCP over http://127.0.0.1:<랜덤포트>/mcp
   ▼
retype 익스텐션 = MCP 서버 + 커맨드
   ▼
파일 편집기: 회색 고스트 ← 사람이 직접 타이핑
```

익스텐션이 확장 호스트 안에서 MCP 서버를 띄우고 `vscode.lm.registerMcpServerDefinitionProvider`로
등록한다. 같은 창의 채팅이 알아서 붙는다. LLM 연동도 API 키도 없다.

## 세 가지

**따라쓰기** — 에이전트가 `propose(text, why)`를 부르면 회색 제안이 뜨고 호출이 멈춘다.
사람이 다 쳐야 돌아간다. 회색은 인라인 완성(여러 줄 통째로)으로 그리고, 따라쓰는 동안 Tab은
수락이 아니라 들여쓰기, Cmd+→는 줄 끝 이동이다. 줄 시작 들여쓰기는 사람이 안 친다 — Enter 치면
자동 들여쓰기가 뭘 넣든 retype이 제안의 들여쓰기로 바꿔놓는다(dedent 포함). 코드는 사람이, 공백은 편집기가.
커서가 줄 중간일 때 들여쓰기 있는/여러 줄 제안이 오면 제안 앞에 줄바꿈을 붙여 "Enter부터"로 맞춘다.

언어 자동완성 팝업을 같이 쓰려면 settings.json에 이게 필요하다. VS Code 기본값
`offWhenInlineCompletions`는 고스트가 떠 있는 동안 팝업을 안 띄운다:

```json
"editor.quickSuggestions": { "other": "on", "comments": "off", "strings": "off" }
``` `why`는 CodeLens로 고스트 위 한 줄에 붙는다.

**구간 질문** — `Cmd+K Q`(win/linux `Ctrl+K Q`)로 지금 화면에 보이는 구간을 질문으로 만들어
채팅을 연다. Claude Code 익스텐션이 있으면 그 입력창에 `@file#L1-20`으로, Copilot Chat이면
`#file` 머리말로, 둘 다 없으면 클립보드로. 에이전트 쪽에서는 `read_viewport()`로 본문을 당겨간다.

**다음 스텝** — 별도 툴이 없다. `propose`가 돌아온다는 것 자체가 한 덩어리가 끝났다는
신호라, 에이전트가 그 자리에서 다음을 제안한다.

## MCP 툴

| 툴 | 하는 일 |
|---|---|
| `propose(text, why, file?, line?)` | 회색 제안을 띄우고 사람이 다 칠 때까지 블로킹. `{typed, ms, mistakes}` 또는 `{typed:false, reason}` (`cancelled`·`abandoned`·`timeout`·이미 있으면 `already_present`). 들여쓰기는 파일 설정(탭/스페이스)으로 맞춰준다 |
| `read_viewport()` | 지금 보이는 파일·줄범위·본문·선택영역 |

## 설치

```bash
npm install
npm run install:local   # vsix 빌드 → code --install-extension
```

**Claude Code 익스텐션이 깔려 있으면 이걸로 끝.** `Cmd+K I`는 그 익스텐션에 든 `claude` 바이너리를 쓰고,
MCP는 실행할 때 `--mcp-config`로 넘기니까 따로 등록할 게 없다. 없으면 `claude` CLI가 PATH에 있으면 된다.

개발: `npm test`(match 유닛), `npm run test:e2e`(진짜 VS Code 띄워서 MCP 클라이언트로 붙는 검사),
F5(`익스텐션 실행`).

## Cmd+K I — 여기서 묻기

편집기에서 `Cmd+K I`(win/linux `Ctrl+K I`, 또는 거터의 `+`) → 커서 줄 밑에 입력창이 붙는다.
할 일을 적고 `⌘⏎` → `claude -p`가 백그라운드로 돌고, 답이 같은 스레드에 달린다. 이어서 물으면
같은 세션(`--resume`)으로 가서 그 스레드의 이전 대화를 다 들고 시작한다. 스레드는 워크스페이스에
저장되어 리로드해도 남는다(접힌 채로, 거터 아이콘 클릭). 다른 스레드끼리는 서로 모른다. 코드는 고스트로 오고 "Edit 말고 propose로" 규칙은
`--append-system-prompt`로 같이 들어간다. 상태바에 도는 아이콘이 진행 표시.


위젯 색은 VS Code 설정으로만 바꿀 수 있다. settings.json에:

```json
"workbench.colorCustomizations": {
  "editorCommentsWidget.unresolvedBorder": "#D97757",
  "editorCommentsWidget.resolvedBorder": "#D9775766",
  "editorCommentsWidget.rangeBackground": "#D9775714",
  "editorCommentsWidget.replyInputBackground": "#00000033"
}
```

## 다른 클라이언트에서 붙이기 (선택)

`Cmd+K I` 말고 Claude Code 패널이나 터미널에서 직접 쓰고 싶으면, 포트가 고정(기본 41773)이라 붙는다:

```bash
claude mcp add --transport http --scope user retype http://127.0.0.1:41773/mcp
```

Copilot agent mode는 익스텐션이 등록해두므로 그냥 보인다. VS Code 창이 둘이면 먼저 뜬 창만 41773을 잡는다.

## 설정

`retype.port` (기본 41773) — MCP 서버 포트. 0이면 랜덤.
`retype.claudePath` (기본 비움) — `Cmd+K I`가 띄울 CLI. 비우면 Claude Code 익스텐션 바이너리 → PATH 순.
`retype.timeoutMinutes` (기본 10) — 따라쓰기 중 입력이 없을 때 포기할 때까지의 분.

## 안 하는 것

- 채팅 UI, LLM 호출, API 키 — 전부 기존 채팅 패널 몫
- 결정 이력 저장, 오타 통계

## 비슷한 것들

- [Claude Code `Learning` output style](https://code.claude.com/docs/en/output-styles) — Claude가 `TODO(human)`을
  남기고 사람이 그 조각을 *직접 설계해서* 쓴다. retype은 반대로 설계는 AI가 하고 사람은 *그대로 따라 친다*.
  Learning은 "네가 생각해 봐", retype은 "네 손으로 지나가 봐".
- [toggle-tab-completion](https://github.com/stefanoaldegheri/toggle-tab-completion) — 고스트를 통째로 끄는 스위치.
  안 보이게 하는 것과 보이되 못 받게 하는 건 다르다.
- 인지부채 담론 — [Comprehension Debt](https://medium.com/@addyosmani/comprehension-debt-the-hidden-cost-of-ai-generated-code-285a25dac57e),
  [Cognitive and Intent Debt](https://queue.acm.org/detail.cfm?id=3807966). 문제는 다들 말하는데 처방은 "리뷰 잘 해라"에서 끝난다.

## 한계

**에이전트가 `propose`를 무시하고 파일을 직접 고치는 건 막을 수 없다.**
retype은 규율 도구지 강제 장치가 아니다.

설계 문서: [docs/superpowers/specs/2026-08-07-retype-design.md](docs/superpowers/specs/2026-08-07-retype-design.md)
