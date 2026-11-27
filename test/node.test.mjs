import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// The compiled build: `pnpm test` runs tsc first
const require = createRequire(import.meta.url);
const { Leapter } = require('../dist/nodes/Leapter/Leapter.node.js');
const { RUN_ADDRESS_MISSING } = require('../dist/nodes/Leapter/cluster.js');
const { NodeApiError } = require('n8n-workflow');

const NODE = { name: 'Leapter', type: 'CUSTOM.leapter', typeVersion: 1, position: [0, 0], parameters: {} };

const node = new Leapter();

// As httpRequestWithAuthentication throws: a NodeApiError around the axios error
class AxiosError extends Error {}
const failed = (status, data) =>
  new NodeApiError(
    NODE,
    Object.assign(new AxiosError(`Request failed with status code ${status}`), {
      response: { status, data, headers: {} },
    }),
  );
// The control plane's answer to a path it does not know, such as an engine path
const controlPlane404 = () =>
  failed(404, {
    type: 'https://docs.leapter.com/problems/runtime-management/unknown-endpoint',
    title: 'Not Found',
    status: 404,
  });
// An engine's answer for a project it does not serve (yet)
const engine404 = () => failed(404, '404 page not found');

const ran = () => ({ body: { total: 3 }, headers: { 'x-run-id': 'run-1' } });

// An execution or field-load context for project dev::app, blueprint bp-1, whose credential holds
// a key for the project. `answer` gets each request through the credential.
let serial = 0;
function context({ credential = {}, answer = ran, parameters: own = {}, input = {} } = {}) {
  serial += 1;
  const calls = [];
  const bodies = [];
  const parameters = { project: 'dev::app', operation: 'bp-1', inputMode: 'json', parametersJson: '{"a":1}', ...own };
  return {
    calls,
    bodies,
    getInputData: () => [{ json: input }],
    getExecutionId: () => 'execution-1',
    getNode: () => NODE,
    async getCredentials() {
      return {
        serviceKey: `lk_mgmt_node_${serial}`,
        clusterUrl: 'https://cluster.example',
        evalKeys: JSON.stringify({ 'dev/app': { id: 'id-1', key: 'lk_dev_app', mintedAt: 1 } }),
        ...credential,
      };
    },
    // Execution: (name, itemIndex, fallback); field load: (name, fallback)
    getNodeParameter: (name, ...rest) =>
      parameters[name] ?? rest.find((value) => typeof value !== 'number' && typeof value !== 'object') ?? {},
    continueOnFail: () => false,
    addExecutionHints() {},
    helpers: {
      async httpRequestWithAuthentication(_type, options) {
        calls.push(`${options.method} ${options.url}`);
        bodies.push(options.body);
        return answer(options);
      },
      async httpRequest(options) {
        calls.push(`${options.method} ${options.url}`);
        throw new Error('no request without the credential expected');
      },
    },
  };
}

test('a run with a key is one request, to the Leapter Server', async () => {
  const ctx = context();
  const [[item]] = await node.execute.call(ctx);
  assert.deepEqual(ctx.calls, ['POST https://cluster.example/runtime/api/v1/dev/app/models/bp-1/runs']);
  assert.equal(item.json.total, 3);
  assert.equal(item.json._metadata.runId, 'run-1');
});

test('a run goes to the Run Address when the credential has one', async () => {
  const ctx = context({ credential: { runUrl: ' http://localhost:3003/ ' } });
  await node.execute.call(ctx);
  assert.deepEqual(ctx.calls, ['POST http://localhost:3003/runtime/api/v1/dev/app/models/bp-1/runs']);
});

test('a Run Address over http to another machine is refused before any request', async () => {
  const ctx = context({ credential: { runUrl: 'http://cluster.example' } });
  await assert.rejects(node.execute.call(ctx), /is not https:\/\//);
  assert.deepEqual(ctx.calls, []);
});

test('a run that reaches the control plane fails at once and names Run Address', async () => {
  const ctx = context({
    answer: () => {
      throw controlPlane404();
    },
  });
  await assert.rejects(node.execute.call(ctx), (error) => error.message === RUN_ADDRESS_MISSING);
  assert.equal(ctx.calls.length, 1);
});

test("an engine's 404 still counts as activation and asks whether the blueprint is public", async () => {
  const ctx = context({
    answer: ({ url }) => {
      if (url.endsWith('/status')) {
        return { environments: [{ applications: [{ slug: 'app', callable: [] }] }] };
      }
      throw engine404();
    },
  });
  await assert.rejects(node.execute.call(ctx), /is not a public blueprint of app/);
  assert.deepEqual(ctx.calls, [
    'POST https://cluster.example/runtime/api/v1/dev/app/models/bp-1/runs',
    'GET https://cluster.example/runtime-management/environments/dev/status',
  ]);
});

test('a field load that reaches the control plane shows the Run Address notice at once', async () => {
  const ctx = context({
    answer: ({ url }) => {
      if (url.endsWith('/status')) {
        return { environments: [{ applications: [{ slug: 'app', callable: [{ id: 'bp-1' }] }] }] };
      }
      throw controlPlane404();
    },
  });
  const answer = await node.methods.resourceMapping.getOperationFields.call(ctx);
  assert.deepEqual(answer, { fields: [], emptyFieldsNotice: RUN_ADDRESS_MISSING });
  assert.deepEqual(ctx.calls, [
    'GET https://cluster.example/runtime-management/environments/dev/status',
    'GET https://cluster.example/runtime/api/v1/dev/app/openapi',
  ]);
});

test('Map Automatically sends the input fields named like a blueprint input, and nothing else', async () => {
  const ctx = context({
    parameters: {
      inputMode: 'visual',
      parameters: {
        mappingMode: 'autoMapInputData',
        value: null,
        schema: [{ id: 'body.positionen' }, { id: 'body.name' }, { id: '__leapter_no_inputs' }],
      },
    },
    input: { positionen: [1, 2], name: 'Acme', other: true, __leapter_no_inputs: 'x' },
  });
  await node.execute.call(ctx);
  assert.deepEqual(ctx.bodies, [{ positionen: [1, 2], name: 'Acme' }]);
});

test('Map Automatically keeps an item\'s string a string, even when it looks like JSON', async () => {
  const ctx = context({
    parameters: {
      inputMode: 'visual',
      parameters: { mappingMode: 'autoMapInputData', value: null, schema: [{ id: 'body.note' }] },
    },
    input: { note: '["draft"]' },
  });
  await node.execute.call(ctx);
  assert.deepEqual(ctx.bodies, [{ note: '["draft"]' }]);
});

test('mapped list inputs are sent as arrays, from JSON text (as 0.2.0 saved them) or an array', async () => {
  const ctx = context({
    parameters: {
      inputMode: 'visual',
      parameters: { mappingMode: 'defineBelow', value: { 'body.saved': '[1, 2, 3]', 'body.mapped': ['a'] } },
    },
  });
  await node.execute.call(ctx);
  assert.deepEqual(ctx.bodies, [{ saved: [1, 2, 3], mapped: ['a'] }]);
});

test('a list input is an array field without a made-up default', async () => {
  const spec = {
    paths: {
      '/models/bp-1/runs': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['positionen'],
                  properties: { positionen: { type: 'array', items: { type: 'number' } } },
                },
              },
            },
          },
        },
      },
    },
  };
  const ctx = context({
    answer: ({ url }) =>
      url.endsWith('/status')
        ? { environments: [{ applications: [{ slug: 'app', callable: [{ id: 'bp-1' }] }] }] }
        : spec,
  });
  const { fields } = await node.methods.resourceMapping.getOperationFields.call(ctx);
  assert.deepEqual(fields, [
    {
      id: 'body.positionen',
      displayName: 'positionen',
      required: true,
      defaultMatch: false,
      display: true,
      type: 'array',
      canBeUsedToMatch: false,
    },
  ]);
});
