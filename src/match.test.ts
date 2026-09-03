import assert from 'node:assert/strict';
import { match } from './match';

// 빈 입력이면 목표 전체가 회색이다
{
  const s = match('return json.loads(raw)', '');
  assert.equal(s.consumed, 0);
  assert.equal(s.remaining, 'return json.loads(raw)');
  assert.equal(s.mistakeAt, null);
  assert.equal(s.done, false);
}

// 앞에서부터 맞으면 그만큼 깎인다
{
  const s = match('return json.loads(raw)', 'ret');
  assert.equal(s.consumed, 3);
  assert.equal(s.remaining, 'urn json.loads(raw)');
  assert.equal(s.mistakeAt, null);
}

// 다 치면 끝난다
{
  const s = match('return raw', 'return raw');
  assert.equal(s.done, true);
  assert.equal(s.remaining, '');
}

// 틀리면 그 자리를 짚는다. 회색은 더 깎이지 않는다
{
  const s = match('return raw', 'retrun');
  assert.equal(s.consumed, 3);
  assert.equal(s.mistakeAt, 3);
  assert.equal(s.done, false);
  assert.equal(s.remaining, 'urn raw');
}

// 지우면 복구된다
{
  const bad = match('return raw', 'retrun');
  assert.equal(bad.mistakeAt, 3);
  const fixed = match('return raw', 'ret');
  assert.equal(fixed.mistakeAt, null);
  assert.equal(fixed.consumed, 3);
}

// 목표보다 많이 치면 남는 글자가 오타다
{
  const s = match('raw', 'raw)');
  assert.equal(s.consumed, 3);
  assert.equal(s.mistakeAt, 3);
  assert.equal(s.done, false);
}

// 자동 들여쓰기: 편집기가 넣은 공백 4칸이 목표의 공백 4칸과 맞는다
{
  const s = match('if x:\n    return 1', 'if x:\n    ');
  assert.equal(s.mistakeAt, null);
  assert.equal(s.remaining, 'return 1');
}

// 자동 들여쓰기가 목표보다 많아도 오타가 아니다 (공백 덩어리 대 덩어리)
{
  const s = match('if x:\n    return 1', 'if x:\n        ');
  assert.equal(s.mistakeAt, null);
  assert.equal(s.remaining, 'return 1');
}

// 자동 들여쓰기가 아직 안 왔으면 회색은 들여쓰기부터 보여준다. 쳐야 한다
{
  const s = match('if x:\n    return 1', 'if x:\n');
  assert.equal(s.mistakeAt, null);
  assert.equal(s.remaining, '    return 1');
}

// 들여쓰기를 건너뛰고 치면 오타다 (회색에 보이는 것과 같은 규칙)
{
  const s = match('if x:\n    return 1', 'if x:\nr');
  assert.equal(s.mistakeAt, 6);
}

// 탭과 스페이스를 섞어도 공백은 공백이다
{
  const s = match('if x:\n\treturn 1', 'if x:\n    ');
  assert.equal(s.mistakeAt, null);
  assert.equal(s.remaining, 'return 1');
}

// 줄바꿈은 공백이 아니다 — 줄을 안 바꾸면 오타다
{
  const s = match('if x:\n    return 1', 'if x: ');
  assert.equal(s.mistakeAt, 5);
}

// 목표 끝의 공백은 끝난 걸로 친다
{
  const s = match('return raw   ', 'return raw');
  assert.equal(s.done, true);
  assert.equal(s.remaining, '');
}

console.log('match: 모든 검사 통과');
