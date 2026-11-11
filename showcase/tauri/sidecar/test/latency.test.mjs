import assert from 'node:assert/strict';
import { createLatency, summary, STAGES } from '../latency.mjs';

{ // Off unless ROAMIES_LATENCY is set: no trace, nothing printed.
  const prev = process.env.ROAMIES_LATENCY;
  delete process.env.ROAMIES_LATENCY;
  const lines = [];
  const lat = createLatency({ print: (s) => lines.push(s) });
  assert.equal(lat.on, false, 'off by default');
  assert.equal(lat.start({ take: 3, voiced: 1, closed: 2, final: 3 }), null, 'no trace to mark');
  assert.deepEqual(lines, []);
  if (prev !== undefined) process.env.ROAMIES_LATENCY = prev;
}

{ // On: the helper's three stages, then each of the sidecar's and the page's once, then one summary line.
  const lines = [];
  let clock = 1_000_400;
  const lat = createLatency({ on: true, print: (s) => lines.push(s), now: () => clock });
  const q = lat.start({ take: 7, voiced: 1_000_000, closed: 1_000_150, final: 1_000_300, why: 'short pause', read: 'live' });
  assert.equal(lines.length, 4, 'voiced, closed, final and received');
  assert.match(lines[0], /^\[latency\] q1\/take7 voiced 1970-01-01T00:16:40\.000Z$/);
  assert.match(lines[1], /closed .* \+150ms$/);
  assert.match(lines[3], /received .* \+100ms$/);
  clock += 50; q.mark('sent');
  clock += 900; q.mark('token');
  clock += 300; q.mark('sentence');
  q.mark('sentence'); // only the first counts
  clock += 500; q.mark('audio');
  q.about.model = 'drama-3';
  q.mark('played', clock + 200); // the page's own time
  q.done(); q.done();
  q.mark('token', clock + 9999);
  const sum = lines.filter((l) => l.includes('summary'));
  assert.equal(sum.length, 1, 'one summary');
  assert.equal(sum[0], '[latency] q1/take7 summary ms: voiced→closed 150, closed→final 150, final→received 100, received→sent 50, sent→token 900, token→sentence 300, sentence→audio 500, audio→played 200 | voiced→played 2350 why=short pause read=live model=drama-3');
  assert.equal(lines.length, 4 + 5 + 1, 'nothing after the summary');
}

{ // A typed question or a stage that never came: the gaps are between the stages there are.
  assert.equal(summary('q2', { received: 10, sent: 30, token: 1030 }), '[latency] q2 summary ms: received→sent 20, sent→token 1000 | received→token 1020');
  assert.deepEqual(STAGES.map(([k]) => k), ['voiced', 'closed', 'final', 'received', 'sent', 'token', 'sentence', 'audio', 'played']);
}
console.log('latency trace: passed');
