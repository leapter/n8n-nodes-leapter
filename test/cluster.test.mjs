import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The compiled build: `pnpm test` runs tsc first
const require = createRequire(import.meta.url);
const { describeClusterError, provisionKey } = require('../dist/nodes/Leapter/cluster.js');

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

test("the control plane's unknown-endpoint 404 names Run Address; an engine's 404 does not", () => {
  const unknown = { type: 'https://docs.leapter.com/problems/runtime-management/unknown-endpoint' };
  assert.match(describeClusterError(404, unknown, {}), /Run Address/);
  assert.match(describeClusterError(404, '404 page not found', {}), /about a minute/);
});

// A context whose credential holds a key for dev/held; the marked request fails with `status`
function provisionContext(status) {
  const calls = [];
  return {
    calls,
    getNode: () => ({ name: 'Leapter', type: 'CUSTOM.leapter', typeVersion: 1, position: [0, 0], parameters: {} }),
    async getCredentials() {
      return {
        serviceKey: `lk_mgmt_provision_${status}`,
        clusterUrl: 'http://localhost:3002',
        evalKeys: JSON.stringify({ 'dev/held': { id: 'id-held', key: 'lk_dev_held', mintedAt: 1 } }),
      };
    },
    helpers: {
      async httpRequestWithAuthentication(type, options) {
        calls.push(options);
        if (status) throw Object.assign(new Error(`status ${status}`), { httpCode: String(status) });
        return {};
      },
    },
  };
}

test('a missing key is requested through a project the credential holds a key for', async () => {
  const ctx = provisionContext(0);
  await provisionKey(ctx, 'http://localhost:3003', 'dev', 'new');
  assert.equal(ctx.calls[0].url, 'http://localhost:3003/runtime/api/v1/dev/held/openapi');
  assert.equal(ctx.calls[0].headers['X-Leapter-Provision'], 'dev/new');
});

test('401 and 404 while requesting a key are left to the request that follows', async () => {
  await provisionKey(provisionContext(401), 'http://localhost:3003', 'dev', 'new');
  await provisionKey(provisionContext(404), 'http://localhost:3003', 'dev', 'new');
});

test('a refused key creation fails at once instead of waiting a minute', async () => {
  for (const status of [403, 500]) {
    await assert.rejects(provisionKey(provisionContext(status), 'http://localhost:3003', 'dev', 'new'), (error) => {
      assert.equal(String(error.httpCode), String(status));
      return true;
    });
  }
});

test('a project with a key needs no request', async () => {
  const ctx = provisionContext(0);
  await provisionKey(ctx, 'http://localhost:3003', 'dev', 'held');
  assert.equal(ctx.calls.length, 0);
});
