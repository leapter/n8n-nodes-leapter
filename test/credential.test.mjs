import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

// The compiled build: `pnpm test` runs tsc first
const require = createRequire(import.meta.url);
const { LeapterApi } = require('../dist/credentials/LeapterApi.credentials.js');
const { clusterBaseUrl } = require('../dist/credentials/eval-keys.js');

const credential = new LeapterApi();
const LONG_AGO = Date.now() - 10 * 60_000;

// The key state is per credential (cluster and service key), so every test uses its own key
let serial = 0;
function data(extra = {}) {
  serial += 1;
  return { serviceKey: `lk_mgmt_${serial}`, clusterUrl: 'http://localhost:3002', evalKeys: '', ...extra };
}

const keys = (stored) => JSON.stringify(stored);
const engine = (project, path = 'openapi') =>
  `http://localhost:3003/runtime/api/v1/${project}/${path}`;

// Tells the credential that a request for the project is about to go out, as n8n does
const request = (credentials, project) => credential.authenticate(credentials, { url: engine(project) });

// A helpers stand-in for the cluster: creates keys (or refuses the projects in `refuse`), revokes
// them, and answers a probe with 401 for the keys in `dead`
function cluster({ refuse = [], dead = [] } = {}) {
  const calls = { minted: [], revoked: [], probed: [] };
  let next = 0;
  return {
    calls,
    helpers: {
      async httpRequest({ url, headers }) {
        if (url.endsWith('/openapi')) {
          calls.probed.push(headers['X-API-Key']);
          if (dead.includes(headers['X-API-Key'])) {
            throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
          }
          return {};
        }
        const [, environment, application, , revoked] = url.match(
          /environments\/([^/]+)\/applications\/([^/]+)\/keys(\/([^/]+)\/revoke)?/,
        );
        if (revoked) {
          calls.revoked.push(revoked);
          return {};
        }
        const project = `${environment}/${application}`;
        if (refuse.includes(project)) {
          throw Object.assign(new Error('Forbidden'), { httpCode: '403' });
        }
        // Lets concurrent calls overlap
        await wait(10);
        next += 1;
        calls.minted.push(project);
        return { key: `lk_dev_${project}_${next}`, credential: { id: `id-${project}-${next}` } };
      },
    },
  };
}

const ids = (answer) =>
  Object.fromEntries(Object.entries(JSON.parse(answer.evalKeys)).map(([project, entry]) => [project, entry.id]));

test('a refused key creation leaves the queue, so later requests are not blocked', async () => {
  const credentials = data();
  const stub = cluster({ refuse: ['nope/app'] });
  await request(credentials, 'nope/app');
  await assert.rejects(credential.preAuthentication.call(stub, credentials), /Forbidden/);

  // Another project's first use now creates its key, and the refused one is not asked again
  await request(credentials, 'dev/app');
  assert.deepEqual(Object.keys(ids(await credential.preAuthentication.call(stub, credentials))), ['dev/app']);
  assert.deepEqual(stub.calls.minted, ['dev/app']);
});

test("another project's refused key creation does not fail this request", async () => {
  const credentials = data();
  await request(credentials, 'nope/app');
  await request(credentials, 'dev/app');
  const answer = await credential.preAuthentication.call(cluster({ refuse: ['nope/app'] }), credentials);
  assert.deepEqual(Object.keys(ids(answer)), ['dev/app']);
});

test('concurrent first uses of one project create one key', async () => {
  const credentials = data();
  const stub = cluster();
  await request(credentials, 'dev/app');
  await request(credentials, 'dev/app');
  const [first, second] = await Promise.all([
    credential.preAuthentication.call(stub, credentials),
    credential.preAuthentication.call(stub, credentials),
  ]);
  assert.deepEqual(stub.calls.minted, ['dev/app']);
  assert.deepEqual(ids(first), ids(second));
});

test('an older copy of the credential keeps the keys created since', async () => {
  const stale = data();
  const stub = cluster();
  await request(stale, 'dev/a');
  await credential.preAuthentication.call(stub, stale);

  // n8n hands the next call the copy it read before the first one was stored
  await request(stale, 'dev/b');
  assert.deepEqual(Object.keys(ids(await credential.preAuthentication.call(stub, stale))).sort(), ['dev/a', 'dev/b']);
  assert.deepEqual(stub.calls.minted, ['dev/a', 'dev/b']);
});

test('only a key the cluster rejects is replaced, whichever request came last', async () => {
  const credentials = data({
    evalKeys: keys({
      'dev/a': { id: 'old-a', key: 'lk_dev_old_a', mintedAt: LONG_AGO },
      'dev/b': { id: 'old-b', key: 'lk_dev_old_b', mintedAt: LONG_AGO },
    }),
  });
  const stub = cluster({ dead: ['lk_dev_old_a'] });
  await request(credentials, 'dev/a');
  // Another project's request in between, as from a parallel execution
  await request(credentials, 'dev/b');
  const answer = await credential.preAuthentication.call(stub, credentials);
  assert.notEqual(ids(answer)['dev/a'], 'old-a');
  assert.equal(ids(answer)['dev/b'], 'old-b');
  assert.deepEqual(stub.calls.revoked, ['old-a']);
});

test('a key within its grace period is neither probed nor replaced', async () => {
  const credentials = data({
    evalKeys: keys({ 'dev/a': { id: 'new-a', key: 'lk_dev_new_a', mintedAt: Date.now() } }),
  });
  const stub = cluster({ dead: ['lk_dev_new_a'] });
  await request(credentials, 'dev/a');
  assert.equal(ids(await credential.preAuthentication.call(stub, credentials))['dev/a'], 'new-a');
  assert.deepEqual(stub.calls.probed, []);
});

test("one credential does not create keys for another credential's projects", async () => {
  const other = data();
  await request(other, 'dev/theirs');
  const stub = cluster();
  await credential.preAuthentication.call(stub, data());
  assert.deepEqual(stub.calls.minted, []);
});

test("a key for another cluster address counts as missing", async () => {
  const credentials = data({
    evalKeys: keys({ 'dev/app': { id: 'x', key: 'lk_dev_x', mintedAt: LONG_AGO, cluster: 'https://old.example.com' } }),
  });
  const options = await request(credentials, 'dev/app');
  assert.equal(options.headers['X-API-Key'], undefined);
  const answer = await credential.preAuthentication.call(cluster(), credentials);
  assert.notEqual(ids(answer)['dev/app'], 'x');
});

test('keys are created under the cluster address even when it names the Admin UI path', async () => {
  const credentials = data({ clusterUrl: 'http://localhost:3002/runtime-management/' });
  const urls = [];
  await request(credentials, 'dev/app');
  await credential.preAuthentication.call(
    {
      helpers: {
        async httpRequest({ url }) {
          urls.push(url);
          return { key: 'lk_dev_k', credential: { id: 'k' } };
        },
      },
    },
    credentials,
  );
  assert.deepEqual(urls, ['http://localhost:3002/runtime-management/environments/dev/applications/app/keys']);
});

test('no key goes to an http address other than localhost', async () => {
  await assert.rejects(
    credential.authenticate(data(), { baseURL: 'http://example.com', url: '/runtime-management/environments' }),
    /https/,
  );
  await assert.rejects(credential.authenticate(data(), { url: 'http://example.com/runtime/api/v1/dev/app/openapi' }), /https/);
  const local = await credential.authenticate(data(), { url: 'http://127.0.0.1:3002/runtime-management/environments' });
  assert.match(local.headers.Authorization, /^Bearer lk_mgmt_/);
  const remote = await credential.authenticate(data(), { url: 'https://runtime.leapter.com/runtime-management/environments' });
  assert.match(remote.headers.Authorization, /^Bearer lk_mgmt_/);
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

test('a provisioning request goes out without any key and makes preAuthentication create the key', async () => {
  const stub = cluster();
  const credentials = data({
    evalKeys: keys({ 'dev/old': { id: 'id-old', key: 'lk_dev_old', mintedAt: LONG_AGO } }),
  });
  const marked = await credential.authenticate(credentials, {
    url: engine('dev/old'),
    headers: { 'X-Leapter-Provision': 'dev/new' },
  });
  assert.deepEqual(marked.headers, {});

  assert.deepEqual(ids(await credential.preAuthentication.call(stub, credentials)), {
    'dev/old': 'id-old',
    'dev/new': 'id-dev/new-1',
  });
  // n8n's repeat after preAuthentication comes without the mark: the engine's own key
  const repeat = await credential.authenticate(credentials, { url: engine('dev/old'), headers: marked.headers });
  assert.equal(repeat.headers['X-API-Key'], 'lk_dev_old');
});

test('a provisioning request for a project that has a key is an ordinary request', async () => {
  const credentials = data({
    evalKeys: keys({ 'dev/app': { id: 'id-app', key: 'lk_dev_app', mintedAt: LONG_AGO } }),
  });
  const answer = await credential.authenticate(credentials, {
    url: engine('dev/app'),
    headers: { 'X-Leapter-Provision': 'dev/app' },
  });
  assert.deepEqual(answer.headers, { 'X-API-Key': 'lk_dev_app' });
});

test('the key field stays empty until a project has a key, so n8n keeps calling preAuthentication', async () => {
  const stub = cluster();
  const credentials = data();
  assert.deepEqual(await credential.preAuthentication.call(stub, credentials), { evalKeys: '' });
});
