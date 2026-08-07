// 사람이 친 글자를 목표 텍스트와 앞에서부터 맞춰본다.
// vscode를 모른다. 순수 함수만 있다.

export type MatchState = {
  /** 목표 텍스트에서 확정된 글자 수 */
  consumed: number;
  /** 사람이 친 텍스트에서 확정된 글자 수 */
  typedOk: number;
  /** 아직 회색으로 남은 부분 */
  remaining: string;
  /** 목표와 어긋나기 시작한 지점 (typed 기준). 어긋난 게 없으면 null */
  mistakeAt: number | null;
  done: boolean;
};

const isSpace = (c: string) => c === ' ' || c === '\t';

/**
 * 목표(target)와 입력(typed)을 두 포인터로 맞춘다.
 *
 * 공백은 덩어리 대 덩어리로 센다. 편집기가 자동 들여쓰기로 공백을 끼워넣어도
 * 오타로 잡히지 않게 하려는 것이다. 줄바꿈은 공백으로 치지 않는다 —
 * 줄이 바뀌는 건 의미가 있다.
 */
export function match(target: string, typed: string): MatchState {
  let t = 0; // target 커서
  let u = 0; // typed 커서

  while (t < target.length && u < typed.length) {
    if (isSpace(target[t]) && isSpace(typed[u])) {
      while (t < target.length && isSpace(target[t])) t++;
      while (u < typed.length && isSpace(typed[u])) u++;
      continue;
    }
    if (target[t] !== typed[u]) break;
    t++;
    u++;
  }

  // 입력이 끝났는데 목표에 공백만 남았다면 그 공백은 미리 먹고 들어간다.
  // (자동 들여쓰기가 아직 안 온 상태에서 회색이 공백부터 시작하는 걸 막는다)
  if (u === typed.length) {
    while (t < target.length && isSpace(target[t])) t++;
  }

  const mistakeAt = u < typed.length ? u : null;

  return {
    consumed: t,
    typedOk: u,
    remaining: target.slice(t),
    mistakeAt,
    done: mistakeAt === null && t === target.length,
  };
}
