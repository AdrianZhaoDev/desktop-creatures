// Real JavaScript <-> native Rust wire fixture. Invoked by the Rust integration test.
// No files, SDK, network, or app-data access: JSON is exchanged only over stdio.
import assert from 'node:assert/strict';

const bytes = new DataView(new ArrayBuffer(8));
const bits = value => { bytes.setFloat64(0, value, false); return bytes.getBigUint64(0, false).toString(); };
let input = '';
for await (const chunk of process.stdin) input += chunk;

if (process.argv[2] === 'generate') {
  const original = JSON.parse(input);
  const critical = 0.00010000900081007291;
  assert.equal(bits(critical), '4547007786161503273');
  const corpus = [
    ['reported-one-ulp', critical, -critical],
    ['tenth', 0.1, -0.1],
    ['third', 1 / 3, -1 / 3],
    ['fixed-step', 1 / 60, -1 / 60],
    ['decimal-sum', 0.1 + 0.2, -(0.1 + 0.2)],
    ['minimum-subnormal', Number.MIN_VALUE, -Number.MIN_VALUE],
    ['next-subnormal', Number.MIN_VALUE * 2, -Number.MIN_VALUE * 2],
    ['largest-subnormal', 2.225073858507201e-308, -2.225073858507201e-308],
    ['minimum-normal', 2.2250738585072014e-308, -2.2250738585072014e-308],
    ['next-normal', 2.225073858507202e-308, -2.225073858507202e-308],
    ['below-one', 0.9999999999999999, 1.0000000000000002],
    ['below-half', 0.49999999999999994, -0.49999999999999994],
    ['above-half', 0.5000000000000001, -0.5000000000000001],
    ['zero', 0, 0],
    ['one', 1, -1],
    ['safe-integer-boundary', 0.1, Number.MAX_SAFE_INTEGER],
    ['negative-safe-integer-boundary', 0.1, -Number.MAX_SAFE_INTEGER],
  ];
  const cases = corpus.map(([name, point, velocity]) => {
    const session = structuredClone(original);
    const run = session.campaign.activeRun;
    run.actors[0].pose.x = point;
    run.actors[0].pose.vx = velocity;
    run.ecology.seconds = point;
    return { name, pointBits: bits(point), velocityBits: bits(velocity), raw: JSON.stringify(session) };
  });
  process.stdout.write(JSON.stringify(cases));
} else if (process.argv[2] === 'verify') {
  const cases = JSON.parse(input);
  let comparisons = 0;
  const numericLeaves = (value, prefix = '') => {
    if (typeof value === 'number') return [[prefix, bits(value)]];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => numericLeaves(child, `${prefix}/${key}`));
  };
  const sortedLeaves = value => numericLeaves(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const entry of cases) {
    const canonical = JSON.parse(entry.canonical);
    const expected = sortedLeaves(canonical);
    assert.equal(bits(canonical.campaign.activeRun.actors[0].pose.x), entry.pointBits);
    assert.equal(bits(canonical.campaign.activeRun.actors[0].pose.vx), entry.velocityBits);
    for (const raw of entry.projections) {
      const projection = JSON.parse(raw);
      assert.deepEqual(sortedLeaves(projection.session), expected, `${entry.name}: native projection bits`);
      comparisons += expected.length;
    }
    for (const raw of entry.restored) {
      assert.deepEqual(sortedLeaves(JSON.parse(raw)), expected, `${entry.name}: native restore bits`);
      comparisons += expected.length;
    }
  }
  process.stdout.write(JSON.stringify({ cases: cases.length, numericBitComparisons: comparisons, reportedValueBits: '4547007786161503273', drift: 0 }));
} else {
  throw new Error('Expected generate or verify');
}
