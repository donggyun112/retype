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
사람이 다 쳐야 돌아간다. `why`는 CodeLens로 고스트 위 한 줄에 붙는다.

**구간 질문** — `Cmd+K Q`(win/linux `Ctrl+K Q`)로 지금 화면에 보이는 구간을 질문으로 만들어
채팅을 연다. 에이전트 쪽에서는 `read_viewport()`로 본문을 당겨간다.

**다음 스텝** — 별도 툴이 없다. `propose`가 돌아온다는 것 자체가 한 덩어리가 끝났다는
신호라, 에이전트가 그 자리에서 다음을 제안한다.

## MCP 툴

| 툴 | 하는 일 |
|---|---|
| `propose(text, why, file?, line?)` | 회색 제안을 띄우고 사람이 다 칠 때까지 블로킹. `{typed, ms, mistakes}` 또는 `{typed:false, reason}` |
| `read_viewport()` | 지금 보이는 파일·줄범위·본문·선택영역 |

## 돌려보기

```bash
npm install
npm test        # match.ts 검사
```

F5(`익스텐션 실행`)로 확장 개발 호스트를 띄운다. 채팅 패널에서 `retype` MCP 서버를 켜면 붙는다.

## 설정

`retype.timeoutMinutes` (기본 10) — 따라쓰기 중 입력이 없을 때 포기할 때까지의 분.

## 안 하는 것

- 채팅 UI, LLM 호출, API 키 — 전부 기존 채팅 패널 몫
- 결정 이력 저장, 오타 통계

## 한계

**에이전트가 `propose`를 무시하고 파일을 직접 고치는 건 막을 수 없다.**
retype은 규율 도구지 강제 장치가 아니다.

설계 문서: [docs/superpowers/specs/2026-08-07-retype-design.md](docs/superpowers/specs/2026-08-07-retype-design.md)
