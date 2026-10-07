import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonPrefixLength, describePlan, meanLogProb, rank, rankingQuestions } from '../src/lib/rank.js';
import { conditionWords } from '../src/lib/plan.js';

test('mean log-probability reads the row before each token', () => {
  // Vocabulary of 2. Row 0 predicts token 1, row 1 predicts token 2.
  const logits = Float32Array.from([0, 0, Math.log(3), 0]);
  // Token 1 is id 0 (row 0: p = 1/2); token 2 is id 0 (row 1: p = 3/4).
  const lp = meanLogProb(logits, 2, [1, 0, 0], 1);
  assert.ok(Math.abs(lp - (Math.log(1 / 2) + Math.log(3 / 4)) / 2) < 1e-6, String(lp));
  assert.equal(meanLogProb(logits, 2, [1], 1), -Infinity, 'nothing to score');
  assert.equal(commonPrefixLength([1, 2, 3], [1, 2, 4, 5]), 2);
});

test('ranking is by how much the plan lifts each answer, and baselines are reused', async () => {
  const calls = [];
  const fake = async (question, { text }) => {
    calls.push(question);
    const plan = question.includes('hike');
    // "water" is likely everywhere; "a torch" only for this plan.
    if (text === 'water.') return plan ? -1 : -1.1;
    return plan ? -2 : -4;
  };
  const q = rankingQuestions({ activity: 'hike', words: null, seasonName: 'winter', part: 'morning' }).bring;
  const baselines = new Map();
  const out = await rank(fake, q, ['water', 'a torch'], baselines);
  assert.deepEqual(out.map((x) => x.c), ['a torch', 'water']);
  assert.equal(baselines.size, 2);
  const before = calls.length;
  await rank(fake, q, ['water', 'a torch'], baselines);
  assert.equal(calls.length - before, 2, 'second plan scores only the plan, not the baselines again');
});

test('the questions carry words, never numbers', () => {
  const words = conditionWords({ minTemp: 3, maxTemp: 9, maxPop: 70, maxUv: 1, maxWind: 25, thunder: false });
  const q = rankingQuestions({ activity: 'hike', words, seasonName: 'autumn', part: 'morning' });
  assert.equal(describePlan({ activity: 'hike', words, seasonName: 'autumn', part: 'morning' }), 'a hike on a cold, rain likely day in the morning in autumn');
  assert.equal(describePlan({ activity: 'walk', words: null, seasonName: 'unknown', part: 'unknown' }), 'a short walk');
  for (const s of [q.bring.question, q.notice.question, q.bring.neutral]) assert.doesNotMatch(s, /[0-9]/);
});
