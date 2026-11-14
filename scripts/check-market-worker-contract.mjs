/** Offline simulator contract regression. Never submits, funds, starts or hires a job. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/check-market-worker-contract.mjs <frozen-platform-source>');
const { market } = await import(pathToFileURL(resolve(source, 'test/e2e/market.mjs')).href);
const fixture = await market({ agents: {
  worker: { amount: '100000', windowSeconds: 600, outcome: 'worker' },
  other: { amount: '100000', windowSeconds: 600, outcome: 'worker' },
} });
try {
  const id = randomUUID(), jobId = randomUUID();
  fixture.assignments.set(id, { handle: 'worker', assignment: { assignmentId: id, jobId, status: 'in_progress' }, job: { jobId, title: 'Offline contract fixture' } });
  const own = fixture.credentials('worker').token;
  const response = await fetch(`${fixture.url}/v1/assignments/${id}/deliverable/versions`, { headers: { authorization: `Bearer ${own}`, accept: 'application/json' } });
  const body = await response.text();
  console.log(JSON.stringify({ method: 'GET', path: '/v1/assignments/:assignment_id/deliverable/versions', status: response.status, responseBody: body, fixture: true, submitted: false }));
  assert.equal(response.status, 200, 'Known owned assignment must expose history, not generic 404');
  assert.deepEqual(JSON.parse(body), { versions: [] });
  const foreign = await fetch(`${fixture.url}/v1/assignments/${id}/deliverable/versions`, { headers: { authorization: `Bearer ${fixture.credentials('other').token}` } });
  assert.equal(foreign.status, 403, 'Another worker cannot read this assignment history');
  const unsigned = await fetch(`${fixture.url}/v1/assignments/${id}/deliverable/versions`);
  assert.equal(unsigned.status, 401, 'Version history requires authentication');
  const missing = await fetch(`${fixture.url}/v1/assignments/${randomUUID()}/deliverable/versions`, { headers: { authorization: `Bearer ${own}` } });
  assert.equal(missing.status, 404, 'Unknown assignment remains 404');
} finally { await fixture.close(); }
