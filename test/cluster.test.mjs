import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The compiled build: `pnpm test` runs tsc first
const require = createRequire(import.meta.url);
const { describeClusterError } = require('../dist/nodes/Leapter/cluster.js');

test("a blueprint's own error messages are shown, not the exception type", () => {
  // As the runtime answers when a blueprint raises an error (insurance-claim-triage, claimAmount 0)
  const body = {
    type: 'about:blank',
    title: 'Run Error',
    status: 500,
    detail: 'Model returned error output',
    properties: {
      errorOutput: [
        { nodeRef: { nodeId: 'X-1' }, title: '', detail: 'Claim amount must be strictly greater than zero.' },
      ],
      exception: { type: 'Error' },
    },
  };
  const message = describeClusterError(500, body, {});
  assert.match(message, /Claim amount must be strictly greater than zero\./);
  assert.doesNotMatch(message, /Exception: Error/);
});

test('a 500 without error output still names the exception', () => {
  const body = { detail: 'Run failed', properties: { exception: { type: 'TypeError' } } };
  assert.equal(describeClusterError(500, body, {}), 'Run failed\nException: TypeError');
});

test('a refusal does not claim the key was revoked when the environment may be the cause', () => {
  const message = describeClusterError(403, { title: 'Forbidden' }, {});
  assert.match(message, /environment/);
  assert.match(message, /Service accounts → n8n/);
});
