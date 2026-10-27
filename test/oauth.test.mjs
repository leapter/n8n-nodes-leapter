import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Expression, NodeHelpers, Workflow } = require('n8n-workflow');
const { LeapterOAuth2Api } = require('../dist/credentials/LeapterOAuth2Api.credentials.js');
const { idTokenUsable, oauthKeys, oauthKeyState } = require('../dist/credentials/oauth-keys.js');
const { credentialTypeOf, controlPlaneRequest, engineRequest, provisionKey } = require('../dist/nodes/Leapter/cluster.js');
const { Leapter } = require('../dist/nodes/Leapter/Leapter.node.js');

const credential = new LeapterOAuth2Api();
const node = new Leapter();
const expression = new Expression('UTC');
const property = (name) => credential.properties.find((entry) => entry.name === name);
const derive = (name, fields) => expression.resolveSimpleParameterValue(property(name).default, { $self: fields });
const key = (id) => ({ id, key: `evaluation-${id}`, mintedAt: Date.now() });
let serial = 0;
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
function data({ expired = false, keys = {}, ...fields } = {}) {
  return {
    clusterUrl: 'https://cluster.example',
    runUrl: 'https://run.example',
    oauthTokenData: {
      id_token: jwt({ sub: `member-${++serial}`, exp: Date.now() / 1000 + (expired ? -1 : 3600) }),
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      leapter_eval_keys: keys,
    },
    ...fields,
  };
}

function context(credentials = data(), { authentication = 'oAuth2', answer, refresh } = {}) {
  const calls = [];
  const saved = [];
  const parameters = { authentication, project: 'test::app', operation: 'blueprint', inputMode: 'json', parametersJson: '{}' };
  const ctx = {
    calls, saved, credentials,
    getNode: () => ({ name: 'Leapter', type: 'CUSTOM.leapter', typeVersion: 1, position: [0, 0], parameters }),
    async getCredentials(type) {
      assert.equal(type, authentication === 'oAuth2' ? 'leapterOAuth2Api' : 'leapterApi');
      return credentials;
    },
    getNodeParameter: (name, ...rest) => parameters[name] ?? rest.find((value) => typeof value !== 'number' && typeof value !== 'object') ?? {},
    getInputData: () => [{ json: {} }],
    getExecutionId: () => 'execution',
    continueOnFail: () => false,
    addExecutionHints() {},
    helpers: {
      async httpRequest(options) {
        calls.push(options);
        if (answer) return await answer(options);
        if (options.url.endsWith('/keys')) return { key: 'new-evaluation-key', credential: { id: 'new-key-id' } };
        return { body: { result: 'ok' }, headers: { 'x-run-id': 'run-id' } };
      },
      async httpRequestWithAuthentication() { throw new Error('OAuth signing must not be used'); },
      async refreshOAuth2Token(type) {
        assert.equal(type, 'leapterOAuth2Api');
        if (refresh) await refresh();
        // n8n runs preAuthentication during refresh and persists the merged token data.
        const updated = await credential.preAuthentication.call(ctx, credentials);
        saved.push(updated.oauthTokenData);
        return updated.oauthTokenData;
      },
    },
  };
  return ctx;
}

const management = { method: 'GET', url: 'https://cluster.example/runtime-management/environments' };
const engine = { method: 'GET', url: 'https://run.example/runtime/api/v1/test/app/openapi' };

test('sign-in defaults to the public CLI client and hosted cluster', () => {
  assert.equal(property('stage'), undefined);
  assert.equal(property('showAdvanced').default, false);
  const defaults = Object.fromEntries(credential.properties.map(({ name, default: value }) => [name, value]));
  for (const fields of [{}, defaults]) {
    assert.equal(derive('clusterUrl', fields), 'https://runtime.leapter.com');
    assert.equal(derive('runUrl', fields), '');
    assert.equal(derive('clientId', fields), '27429955-4cf8-4cfe-bcc7-fc2fb57989d6');
    assert.equal(derive('authUrl', fields), 'https://yyahhgbxjvmqtdbgqgiy.supabase.co/auth/v1/oauth/authorize');
    assert.equal(derive('accessTokenUrl', fields), 'https://yyahhgbxjvmqtdbgqgiy.supabase.co/auth/v1/oauth/token');
  }
});

test('custom server settings survive n8n credential save and derive all addresses and client id', () => {
  const fields = {
    showAdvanced: true,
    customClusterUrl: 'https://cluster.example', customRunUrl: 'https://run.example',
    customSignInServer: ' https://identity.example/auth/v1/ ', customClientId: ' custom-client ',
  };
  // Match the credential editor's save, including its removal of non-displayed fields.
  const saved = NodeHelpers.getNodeParameters(credential.properties, fields, false, false, null, null);
  assert.deepEqual(saved, fields);
  for (const values of [fields, saved]) {
    assert.equal(derive('clusterUrl', values), fields.customClusterUrl);
    assert.equal(derive('runUrl', values), fields.customRunUrl);
    assert.equal(derive('clientId', values), 'custom-client');
    assert.equal(derive('authUrl', values), 'https://identity.example/auth/v1/oauth/authorize');
    assert.equal(derive('accessTokenUrl', values), 'https://identity.example/auth/v1/oauth/token');
  }
  assert.equal(derive('runUrl', { ...fields, customRunUrl: undefined }), '');
  const customFields = credential.properties.filter((entry) => entry.displayOptions?.show?.showAdvanced?.includes(true));
  assert.equal(customFields.length, 4);
});

test('turning off custom server selects hosted settings before and after n8n saves', () => {
  const fields = {
    showAdvanced: false,
    customClusterUrl: 'https://cluster.example', customRunUrl: 'https://run.example',
    customSignInServer: 'https://identity.example/auth/v1', customClientId: 'custom-client',
  };
  const saved = NodeHelpers.getNodeParameters(credential.properties, fields, false, false, null, null);
  assert.deepEqual(saved, {});
  for (const name of ['clusterUrl', 'runUrl', 'clientId', 'authUrl', 'accessTokenUrl']) {
    assert.equal(derive(name, fields), derive(name, {}));
    assert.equal(derive(name, saved), derive(name, {}));
  }
});

test('sign-in uses PKCE, hides OAuth plumbing, and keeps keys inside token data only', () => {
  assert.equal(credential.name, 'leapterOAuth2Api');
  assert.equal(credential.displayName, 'Leapter OAuth2 API');
  assert.deepEqual(credential.extends, ['oAuth2Api']);
  assert.equal(property('grantType').default, 'pkce');
  assert.equal(property('scope').default, 'openid email profile');
  assert.equal(property('evalKeys'), undefined);
  assert.equal(credential.authenticate, undefined);
  assert.equal(credential.properties[0].type, 'notice');
  for (const name of ['authUrl', 'accessTokenUrl', 'clientId', 'clusterUrl', 'runUrl']) {
    assert.equal(property(name).type, 'hidden');
  }
});

test('authentication defaults to Service Account Key and binds each credential to its option', () => {
  const auth = node.description.properties.find((entry) => entry.name === 'authentication');
  assert.equal(auth.default, 'serviceAccountKey');
  assert.deepEqual(auth.options, [
    { name: 'Service Account Key', value: 'serviceAccountKey' }, { name: 'OAuth2', value: 'oAuth2' },
  ]);
  assert.deepEqual(node.description.credentials.map(({ name, displayOptions }) => [name, displayOptions.show.authentication]), [
    ['leapterApi', ['serviceAccountKey']], ['leapterOAuth2Api', ['oAuth2']],
  ]);
  assert.equal(credentialTypeOf({ getNode: () => ({ parameters: {} }) }), 'leapterApi');
});

test('management sends the id token as Bearer through plain HTTP, never the access token', async () => {
  const ctx = context();
  await controlPlaneRequest(ctx, { ...management, headers: { authorization: 'wrong', 'x-api-key': 'wrong', Accept: 'application/json' } });
  assert.deepEqual(ctx.calls[0].headers, { Accept: 'application/json', Authorization: `Bearer ${ctx.credentials.oauthTokenData.id_token}` });
  assert.equal(ctx.calls[0].disableFollowRedirect, true);
});

test('engine sends only the evaluation key and keeps non-auth headers', async () => {
  const stored = key('app');
  const ctx = context(data({ keys: { 'test/app': stored } }));
  await engineRequest(ctx, 'test', 'app', {
    ...engine, headers: { Authorization: 'secret', authorization: 'secret', 'X-API-Key': 'old', 'x-api-key': 'old', 'X-Correlation-Id': 'execution' },
  });
  assert.deepEqual(ctx.calls[0].headers, { 'X-API-Key': stored.key, 'X-Correlation-Id': 'execution' });
  assert.equal(ctx.calls[0].disableFollowRedirect, true);
});

test('a missing key is created with the id token and saved immediately through OAuth refresh', async () => {
  const ctx = context();
  await provisionKey(ctx, 'https://run.example', 'test', 'app');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].method, 'POST');
  assert.equal(ctx.calls[0].url, 'https://cluster.example/runtime-management/environments/test/applications/app/keys');
  assert.equal(ctx.calls[0].headers.Authorization, `Bearer ${ctx.credentials.oauthTokenData.id_token}`);
  assert.deepEqual(ctx.calls[0].body, { reason: 'n8n node (sign in)', usedBy: 'n8n' });
  assert.equal(ctx.saved.length, 1);
  assert.equal(ctx.saved[0].leapter_eval_keys['test/app'].id, 'new-key-id');
  for (const name of ['access_token', 'refresh_token', 'id_token']) {
    assert.equal(ctx.saved[0][name], ctx.credentials.oauthTokenData[name]);
  }
});

test('an expired sign-in without a project key fails before any request or refresh', async () => {
  const ctx = context(data({ expired: true }));
  await assert.rejects(node.execute.call(ctx), /Access to app needs a new sign-in: the Leapter sign-in is older than an hour\. Open the credential and reconnect\./);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.saved, []);
});

test('disconnect clears access to stored and cached keys and asks to connect without sending requests', async () => {
  const credentials = data({ keys: { 'test/app': key('stored') } });
  oauthKeyState(credentials).latest['test/app'] = key('cached');
  // n8n's Disconnect action deletes the entire OAuth token-data block.
  delete credentials.oauthTokenData;
  assert.deepEqual(oauthKeys(credentials), {});
  for (const method of [node.execute, node.methods.listSearch.searchProjects, node.methods.loadOptions.getOperations]) {
    const ctx = context(credentials);
    await assert.rejects(method.call(ctx), /The Leapter credential is not connected\. Open the credential and connect\./);
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.saved, []);
  }
});

test('expired sign-ins cannot list projects or blueprints and send no requests', async () => {
  for (const method of [node.methods.listSearch.searchProjects, node.methods.loadOptions.getOperations]) {
    const ctx = context(data({ expired: true }));
    await assert.rejects(method.call(ctx), /The Leapter sign-in is older than an hour, so projects and blueprints cannot be listed\. Open the credential and reconnect\. Runs keep working\./);
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.saved, []);
  }
});

test('a run with a stored key is one engine request even after the id token expires', async () => {
  const ctx = context(data({ expired: true, keys: { 'test/app': key('app') } }));
  const [[item]] = await node.execute.call(ctx);
  assert.equal(item.json.result, 'ok');
  assert.equal(item.json._metadata.runId, 'run-id');
  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0].url, /\/models\/blueprint\/runs$/);
  assert.equal(ctx.calls[0].headers.Authorization, undefined);
  assert.deepEqual(ctx.saved, []);
});

test('the id token expiry check has a 60 second margin and safely rejects malformed tokens', () => {
  for (const id_token of [undefined, '', 'malformed', 'x.invalid.y', jwt({}), jwt({ exp: 'later' }), jwt({ exp: Date.now() / 1000 + 59 })]) {
    assert.equal(idTokenUsable({ id_token }), false);
  }
  assert.equal(idTokenUsable({ id_token: jwt({ exp: Date.now() / 1000 + 61 }) }), true);
});

test('concurrent first uses mint once and stale copies preserve keys for other projects', async () => {
  const ctx = context();
  await Promise.all([
    provisionKey(ctx, 'https://run.example', 'test', 'app'),
    provisionKey(ctx, 'https://run.example', 'test', 'app'),
    provisionKey(ctx, 'https://run.example', 'test', 'other'),
  ]);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.saved.length, 2);
  assert.deepEqual(Object.keys(ctx.saved[1].leapter_eval_keys).sort(), ['test/app', 'test/other']);
});

test('a failed save is reported and retried without creating a duplicate key', async () => {
  let attempts = 0;
  const ctx = context(data(), { refresh: () => { if (++attempts === 1) throw new Error('refresh failed'); } });
  await assert.rejects(provisionKey(ctx, 'https://run.example', 'test', 'app'), /could not be saved.*reconnect/);
  await provisionKey(ctx, 'https://run.example', 'test', 'app');
  assert.equal(ctx.calls.length, 1);
  assert.equal(attempts, 2);
  assert.equal(ctx.saved.length, 1);
});

test('a refused mint leaves the queue usable and is not treated as a saved key', async () => {
  let attempts = 0;
  const ctx = context(data(), { answer: () => {
    if (++attempts === 1) throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
    return { key: 'evaluation-key', credential: { id: 'new-key' } };
  } });
  await assert.rejects(provisionKey(ctx, 'https://run.example', 'test', 'app'));
  assert.deepEqual(oauthKeys(ctx.credentials), {});
  await provisionKey(ctx, 'https://run.example', 'test', 'app');
  assert.equal(ctx.saved.length, 1);
});

test('in-memory keys are isolated by sign-in and cluster, and stored keys are cluster-bound', async () => {
  const ctx = context();
  await provisionKey(ctx, 'https://run.example', 'test', 'app');
  assert.deepEqual(oauthKeys(data()), {});
  assert.deepEqual(oauthKeys({ ...ctx.credentials, clusterUrl: 'https://another.example' }), {});
  const savedElsewhere = { ...ctx.credentials, clusterUrl: 'https://another.example', oauthTokenData: ctx.saved[0] };
  assert.deepEqual(oauthKeys(savedElsewhere), {});
});

test('reconnect carries stored keys into a new sign-in without dropping any tokens', async () => {
  const credentials = data({ keys: { 'test/app': key('app'), 'test/other': key('other') } });
  const { oauthTokenData } = await credential.preAuthentication.call({}, credentials);
  assert.deepEqual(oauthTokenData, credentials.oauthTokenData);
  assert.deepEqual(oauthKeyState(credentials).latest, {});
});

test('plain OAuth requests refuse insecure remote addresses before sending credentials', async () => {
  const ctx = context(data({ clusterUrl: 'http://insecure.example', keys: { 'test/app': key('app') } }));
  await assert.rejects(controlPlaneRequest(ctx, { ...management, url: 'http://insecure.example/runtime-management/environments' }), /not https/);
  await assert.rejects(engineRequest(ctx, 'test', 'app', { ...engine, url: 'http://insecure.example/runtime/api/v1/test/app/openapi' }), /not https/);
  await assert.rejects(provisionKey(ctx, 'https://run.example', 'test', 'other'), /not https/);
  assert.deepEqual(ctx.calls, []);
});

test('a refresh that skips preAuthentication must not silently lose a newly created key', async () => {
  const ctx = context();
  const save = ctx.helpers.refreshOAuth2Token;
  ctx.helpers.refreshOAuth2Token = async () => ctx.credentials.oauthTokenData;
  await assert.rejects(provisionKey(ctx, 'https://run.example', 'test', 'app'), /could not be saved/);
  ctx.helpers.refreshOAuth2Token = save;
  await provisionKey(ctx, 'https://run.example', 'test', 'app');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.saved.length, 1);
});

test('OAuth permission failures name the signed-in account and required role', async () => {
  const ctx = context(data(), { answer: () => {
    throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
  } });
  await assert.rejects(node.execute.call(ctx), /signed-in account.*operator role/);
});


test('n8n fills the default and accepts the old credential when loading an unchanged saved workflow', () => {
  const savedNode = {
    name: 'Leapter', type: 'CUSTOM.leapter', typeVersion: 1, position: [0, 0],
    parameters: { project: { __rl: true, mode: 'list', value: 'test::app' }, operation: 'blueprint' },
    credentials: { leapterApi: { id: 'existing-credential', name: 'Leapter API' } },
  };
  const workflow = new Workflow({
    id: 'saved-workflow', nodes: [savedNode], connections: {}, active: false,
    nodeTypes: { getByNameAndVersion: () => node },
  });
  const loaded = workflow.getNode('Leapter');
  assert.equal(loaded.parameters.authentication, 'serviceAccountKey');
  const displayed = node.description.credentials.filter((entry) =>
    NodeHelpers.displayParameter(loaded.parameters, entry, loaded, node.description, loaded.parameters),
  );
  assert.deepEqual(displayed.map((entry) => entry.name), ['leapterApi']);
  assert.deepEqual(loaded.credentials, savedNode.credentials);
});
