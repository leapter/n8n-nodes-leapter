import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';

// The compiled build: `pnpm test` runs tsc first
const require = createRequire(import.meta.url);
const { LeapterApi } = require('../dist/credentials/LeapterApi.credentials.js');
const { clusterBaseUrl, lastRequested, lastUsed, pending } = require('../dist/credentials/eval-keys.js');

const credential = new LeapterApi();

// A helpers stand-in: mints a key per call, or refuses the projects in `refuse`
function cluster(refuse = []) {
  const minted = [];
  return {
    minted,
    helpers: {
      async httpRequest({ url }) {
        const project = url.match(/environments\/([^/]+)\/applications\/([^/]+)\/keys/).slice(1).join('/');
        if (refuse.includes(project)) {
          throw Object.assign(new Error('Forbidden'), { httpCode: '403' });
        }
        minted.push(url);
        return { key: `lk_dev_${project}`, credential: { id: `id-${project}` } };
      },
    },
  };
}

const data = (extra = {}) => ({ serviceKey: 'lk_mgmt_x', clusterUrl: 'http://localhost:3002', evalKeys: '', ...extra });

beforeEach(() => {
  pending.clear();
  lastUsed.clear();
  delete lastRequested.project;
});

test('a refused key creation leaves the queue, so later requests are not blocked', async () => {
  pending.add('nope/app');
  lastRequested.project = 'nope/app';
  await assert.rejects(credential.preAuthentication.call(cluster(['nope/app']), data()), /Forbidden/);
  assert.equal(pending.size, 0);

  // Another project's first use now creates its key
  pending.add('dev/app');
  lastRequested.project = 'dev/app';
  const answer = await credential.preAuthentication.call(cluster(['nope/app']), data());
  assert.deepEqual(Object.keys(JSON.parse(answer.evalKeys)), ['dev/app']);
});

test("another project's refused key creation does not fail this request", async () => {
  pending.add('nope/app');
  pending.add('dev/app');
  lastRequested.project = 'dev/app';
  const answer = await credential.preAuthentication.call(cluster(['nope/app']), data());
  assert.deepEqual(Object.keys(JSON.parse(answer.evalKeys)), ['dev/app']);
  assert.equal(pending.size, 0);
});

test('keys are created under the cluster address even when it names the Admin UI path', async () => {
  pending.add('dev/app');
  lastRequested.project = 'dev/app';
  const stub = cluster();
  await credential.preAuthentication.call(stub, data({ clusterUrl: 'http://localhost:3002/runtime-management/' }));
  assert.deepEqual(stub.minted, ['http://localhost:3002/runtime-management/environments/dev/applications/app/keys']);
});

test('no key goes to an http address other than localhost', async () => {
  await assert.rejects(
    credential.authenticate(data(), { baseURL: 'http://example.com', url: '/runtime-management/environments' }),
    /https/,
  );
  await assert.rejects(
    credential.authenticate(data(), { url: 'http://example.com/runtime/api/v1/dev/app/openapi' }),
    /https/,
  );
  const local = await credential.authenticate(data(), { url: 'http://127.0.0.1:3002/runtime-management/environments' });
  assert.equal(local.headers.Authorization, 'Bearer lk_mgmt_x');
  const remote = await credential.authenticate(data(), { url: 'https://runtime.leapter.com/runtime-management/environments' });
  assert.equal(remote.headers.Authorization, 'Bearer lk_mgmt_x');
});

test('the evaluation keys are a secret n8n redacts in the editor', () => {
  const evalKeys = credential.properties.find((property) => property.name === 'evalKeys');
  assert.equal(evalKeys.typeOptions.password, true);
  assert.equal(evalKeys.typeOptions.expirable, true);
});

test('the cluster address drops a trailing Admin UI path and slashes', () => {
  assert.equal(clusterBaseUrl('http://localhost:3002/runtime-management/'), 'http://localhost:3002');
  assert.equal(clusterBaseUrl('https://runtime.leapter.com/runtime-management/environments'), 'https://runtime.leapter.com');
  assert.equal(clusterBaseUrl('https://example.org/cluster/'), 'https://example.org/cluster');
  assert.equal(clusterBaseUrl(''), 'https://runtime.leapter.com');
  assert.equal(clusterBaseUrl(undefined), 'https://runtime.leapter.com');
});
