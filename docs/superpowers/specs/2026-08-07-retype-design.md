# retype — 설계

날짜: 2026-08-07
상태: 승인됨

## 목표

AI 작업물에 대한 인간의 인지부채를 줄인다.

인지부채는 사람이 자기가 짜지 않은 코드를 떠안을 때 쌓인다. AI가 코드를 적용하는 대신 **불러주고**, 사람이 자기 손으로 치게 만들면 그 부채가 쌓이는 지점 자체가 사라진다. retype은 그 전환을 편집기 안에서 강제하는 VSCode 익스텐션이다.

## 범위

VSCode 익스텐션 한 개. 그 안에 MCP 서버가 들어 있다.

기능 세 가지:

1. **따라쓰기** — AI 제안을 회색 임시 상태로 띄우고, 사람이 직접 타이핑해야 확정된다. Tab으로 삽입되지 않는다.
2. **구간 질문** — 커맨드 하나로 지금 화면에 보이는 구간을 채팅에 바로 올린다.
3. **다음 스텝 제안** — 따라쓰기 한 덩어리가 끝나는 순간 AI가 다음을 제안하거나 물어본다.

## 구조

```
채팅 패널 (Copilot agent mode 등 — MCP 클라이언트)
   │  MCP over http://127.0.0.1:PORT
   ▼
retype 익스텐션 = MCP 서버 + 커맨드
   ▼
파일 편집기: 회색 고스트 ← 사람이 직접 타이핑
```

익스텐션은 확장 호스트 프로세스 안에서 localhost HTTP MCP 서버를 띄우고,
`vscode.lm.registerMcpServerDefinitionProvider`로 `McpHttpServerDefinition`을 등록한다.
같은 창의 채팅 패널이 자동으로 붙는다.

별도 프로세스도 IPC도 없다. MCP 툴 핸들러가 vscode API를 직접 호출한다.

근거: `vscode.lm.registerMcpServerDefinitionProvider` + `contributes.mcpServerDefinitionProviders`
기여 지점 (VS Code Extension API — api/extension-guides/ai/mcp.md).

### 왜 익스텐션이 MCP 서버인가

반대 방향(익스텐션이 LLM을 직접 호출)이면 API 키·모델 선택·프롬프트·대화 이력·비용을 전부 직접 떠안는다.
사용자는 이미 VSCode 안에서 에이전트 채팅을 쓰고 있다. 그 에이전트가 우리 툴을 부르게 하면
LLM 연동 코드가 0줄이 된다.

## 구성 요소

경계가 셋이고, 각각 독립적으로 이해·테스트된다.

### `match.ts` — 타이핑 매칭 (순수 함수)

vscode를 import하지 않는다. 상태 전이만 계산한다.

```
advance(state, newDocumentText) -> {
  confirmed: number,      // 앞에서부터 몇 자가 목표와 일치하는가
  remaining: string,      // 아직 회색으로 남은 부분
  mistake: Range | null,  // 목표와 어긋난 구간
  done: boolean
}
```

의존성 없음. 이 파일이 유일한 자동 테스트 대상이다.

### `ghost.ts` — 편집기 표시

`match.ts`의 결과를 `TextEditorDecorationType`으로 그린다.

`InlineCompletionItemProvider`(코파일럿 방식)는 쓰지 않는다. Tab이 무조건 삽입해버려서
"재타이핑 강제"라는 전제가 무너진다. 데코레이션의 `after` contentText는 순수 시각 요소라
Tab이 먹을 대상 자체가 없다.

입력은 `onDidChangeTextDocument`로 받는다.

### `server.ts` — MCP 툴

`ghost.ts`와 편집기 상태를 툴 두 개로 노출한다.

## MCP 툴

### `propose(file, line, text, why)`

`file`의 `line` 시작 위치로 커서를 옮기고, 거기에 `text`를 회색으로 그리고 **블로킹한다**.
`line`을 생략하면 현재 커서 자리를 쓴다.
`why`는 고스트 위에 한 줄로 붙는다 — 작업물에 '왜'가 항상 동행하는 지점이다.

리턴:

```
{ typed: true,  ms: number, mistakes: Range[] }
{ typed: false, reason: "abandoned" | "timeout" | "cancelled" }
```

### `read_viewport()`

지금 화면에 보이는 파일 경로 · 줄 범위 · 본문을 리턴한다. 구간 질문의 에이전트 쪽 절반.

### 다음 스텝 제안에 툴이 없는 이유

`propose`의 리턴이 곧 "한 덩어리 끝남" 신호다. 에이전트는 그 리턴을 받은 자리에서
자연스럽게 다음을 제안한다. 타이머도, idle 감지도, 별도 툴도 필요 없다.

시간·줄수 같은 임의 기준 없이 여백을 구조적으로 알 수 있는 유일한 지점이다.

## 익스텐션 커맨드

### `retype: 이 구간 물어보기`

뷰포트 범위를 질문 문맥으로 만들어 채팅을 열고 채워넣는다 (`workbench.action.chat.open`).

**미확인**: 이 커맨드가 query 인자를 받는지 문서로 확인하지 못했다.
구현 첫 단계에서 실측하고, 받지 않으면 클립보드 복사로 폴백한다.

## 데이터 흐름

```
에이전트 ── propose(text, why) ──▶ ghost.ts: 회색 그림, 블로킹
                                      │
사람이 타이핑 ──▶ onDidChangeTextDocument ──▶ match.ts
                                      │
                              회색 깎임 / 오타 표시
                                      │
                              remaining 0자
                                      ▼
에이전트 ◀── { typed:true, ms, mistakes } ── 블로킹 해제
       │
       └─▶ 다음 스텝 제안
```

## 에러 처리

| 상황 | 동작 |
|---|---|
| 도중에 다른 파일로 이동 / 문서 닫힘 | `{typed:false, reason:"abandoned"}` 즉시 리턴 |
| 아무 입력 없이 10분 | `{typed:false, reason:"timeout"}` |
| 사람이 Esc | `{typed:false, reason:"cancelled"}` |
| 목표와 다른 글자 | 빨간 밑줄. 회색은 깎이지 않음. 지우면 복구 |

블로킹 툴은 어떤 경우에도 매달려 있지 않는다. 모든 경로에 리턴이 있다.

## 한계 (명시)

**에이전트가 `propose`를 무시하고 직접 파일을 편집하는 것은 막을 수 없다.**
retype은 규율 도구지 강제 장치가 아니다. 에이전트가 협조할 때만 동작한다.

## 검증

`match.ts`에 대한 assert 기반 테스트 하나. vscode 없이 돌아간다.
프레임워크 없음, 픽스처 없음.

나머지(데코레이션 렌더링, MCP 연결, 채팅 열기)는 손으로 확인한다.
VSCode API 래핑 계층을 자동 테스트하는 비용이 얻는 것보다 크다.

## 만들지 않는 것

- 채팅 UI — 기존 패널을 붙어쓴다
- LLM 연동 · API 키 · 모델 선택
- 결정 이력 저장/복원 — 인지부채의 다른 축이지만 이번 범위 밖
- 오타 통계 · 대시보드
- 멀티 커서, 멀티 파일 동시 고스트
