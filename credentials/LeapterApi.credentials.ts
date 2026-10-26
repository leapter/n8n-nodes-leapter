import type {
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IDataObject,
  IHttpRequestHelper,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';
import {
  DEFAULT_CLUSTER_URL,
  GRACE_MS,
  PROVISION_HEADER,
  RECENT_USE_MS,
  clusterBaseUrl,
  currentKeys,
  isSecureAddress,
  keyState,
} from './eval-keys';
import type { KeyState } from './eval-keys';

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * The work of preAuthentication: a key for every project requested without one, and a new key
 * for every recently used project whose key the engine rejects
 */
async function refreshKeys(
  ctx: IHttpRequestHelper,
  credentials: ICredentialDataDecryptedObject,
  state: KeyState,
): Promise<IDataObject> {
  const cluster = clusterBaseUrl(credentials.clusterUrl);
  const authorization = `Bearer ${credentials.serviceKey as string}`;
  const map = currentKeys(credentials);
  const keysUrl = (project: string) => {
    const [environment, application] = project.split('/');
    return `${cluster}/runtime-management/environments/${environment}/applications/${application}/keys`;
  };
  const mint = async (project: string) => {
    const answer = (await ctx.helpers.httpRequest({
      method: 'POST',
      url: keysUrl(project),
      headers: { Authorization: authorization },
      body: { reason: 'n8n node', usedBy: 'n8n' },
      json: true,
    })) as { key: string; credential: { id: string } };
    map[project] = { id: answer.credential.id, key: answer.key, mintedAt: Date.now(), cluster };
  };

  // Only the requested project's refusal fails this request; another project's (gone, or an
  // environment without rights) is not asked again until it is requested again
  let refusal: unknown;
  const attempt = async (project: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      if (project === state.lastRequested) {
        refusal = error;
      }
    }
  };

  for (const project of [...state.pending]) {
    state.pending.delete(project);
    if (!map[project]) {
      await attempt(project, async () => await mint(project));
    }
  }

  // A 401 does not say which request got it, and other projects' requests run meanwhile. So every
  // recently used key past its grace period is probed, and only a key the engine rejects is
  // replaced.
  for (const [project, use] of state.used) {
    const stored = map[project];
    const now = Date.now();
    if (!stored || now - use.at > RECENT_USE_MS || now - stored.mintedAt <= GRACE_MS) {
      continue;
    }
    if (!(await isRejected(ctx, use.probeUrl, stored.key))) {
      continue;
    }
    await attempt(project, async () => {
      await mint(project);
      try {
        await ctx.helpers.httpRequest({
          method: 'POST',
          url: `${keysUrl(project)}/${stored.id}/revoke`,
          headers: { Authorization: authorization },
          body: { reason: 'n8n node: replaced' },
          json: true,
        });
      } catch {
        // The replacement works without it; the old key stays until revoked in the Admin UI
      }
    });
  }

  // Kept even when this call fails, so the keys it created are not lost
  state.latest = map;
  if (refusal !== undefined) {
    throw refusal;
  }
  // Empty while no project has a key: n8n then runs preAuthentication before every request
  return { evalKeys: Object.keys(map).length > 0 ? JSON.stringify(map) : '' };
}

/**
 * Whether the engine rejects the key (401). Any other answer, or none, keeps the key.
 */
async function isRejected(
  ctx: IHttpRequestHelper,
  probeUrl: string,
  key: string,
): Promise<boolean> {
  try {
    await ctx.helpers.httpRequest({
      method: 'GET',
      url: probeUrl,
      headers: { 'X-API-Key': key },
      json: true,
      disableFollowRedirect: true,
    });
    return false;
  } catch (error) {
    const e = error as { httpCode?: string; response?: { status?: number } };
    return (e.response?.status ?? Number(e.httpCode)) === 401;
  }
}

/**
 * Leapter Runtime Cluster Credential
 *
 * Holds a service key of the cluster's n8n service account. The control plane
 * takes the service key; the engines take only a project's evaluation key.
 */
export class LeapterApi implements ICredentialType {
  name = 'leapterApi';
  displayName = 'Leapter API';
  documentationUrl = 'https://github.com/leapter/n8n-nodes-leapter#readme';
  icon = { light: 'file:leapter.svg', dark: 'file:leapter.dark.svg' } as const;

  properties: INodeProperties[] = [
    {
      displayName: 'Service Key',
      name: 'serviceKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'A key of the n8n service account. Create it in the Admin UI: Service accounts → n8n → Create key.',
      hint: 'Starts with lk_mgmt_',
    },
    {
      displayName: 'Advanced Settings',
      name: 'showAdvanced',
      type: 'boolean',
      default: false,
      description: 'Whether to show advanced settings like the server URL',
    },
    {
      displayName: 'Leapter Server',
      name: 'clusterUrl',
      type: 'string',
      default: DEFAULT_CLUSTER_URL,
      description:
        'The Leapter Runtime Cluster. Only change for self-hosted clusters or development.',
      displayOptions: {
        show: {
          showAdvanced: [true],
        },
      },
    },
    {
      displayName: 'Evaluation Keys',
      name: 'evalKeys',
      type: 'hidden',
      // password: n8n redacts the keys before the editor gets the credential, and a save puts
      // the stored value back in place of the redacted one
      typeOptions: { expirable: true, password: true },
      default: '',
    },
  ];

  // Control plane requests get the service key, engine requests the project's evaluation key
  async authenticate(
    credentials: ICredentialDataDecryptedObject,
    requestOptions: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> {
    // n8n re-runs authenticate on already-authenticated options when it retries
    const headers = { ...(requestOptions.headers ?? {}) };
    delete headers.Authorization;
    delete headers['X-API-Key'];

    const url = (requestOptions.baseURL ?? '') + requestOptions.url;
    // Never a key over plain http to another machine, the credential test included
    if (!isSecureAddress(url)) {
      throw new Error(`The address ${url} is not https://. Only localhost may be reached without it.`);
    }
    const path = pathOf(url);

    // provisionKey(): no key at all, so this engine answers 401 and n8n runs preAuthentication,
    // which creates the named project's key. n8n's repeat after that comes without the mark.
    const provision = headers[PROVISION_HEADER];
    delete headers[PROVISION_HEADER];
    if (typeof provision === 'string' && !currentKeys(credentials)[provision]) {
      const state = keyState(credentials);
      state.pending.add(provision);
      state.lastRequested = provision;
      return { ...requestOptions, headers };
    }

    if (path.includes('/runtime-management/')) {
      headers.Authorization = `Bearer ${credentials.serviceKey as string}`;
    } else {
      const match = path.match(/\/runtime\/api\/v1\/([^/]+)\/([^/]+)\//);
      if (match) {
        const project = `${match[1]}/${match[2]}`;
        const state = keyState(credentials);
        state.lastRequested = project;
        const entry = currentKeys(credentials)[project];
        if (entry) {
          headers['X-API-Key'] = entry.key;
          const probeUrl = `${url.slice(0, url.indexOf(match[0]) + match[0].length)}openapi`;
          state.used.set(project, { at: Date.now(), probeUrl });
        } else {
          state.pending.add(project);
        }
      }
    }

    return { ...requestOptions, headers };
  }

  // Runs before every request while evalKeys is empty, after every 401 and on every credential
  // test (every n8n version since 2.0): creates missing evaluation keys and replaces rejected ones.
  // n8n stores the returned evalKeys in the credential. One call at a time per credential, so
  // parallel requests neither create a key twice nor store an older map over a newer one.
  async preAuthentication(
    this: IHttpRequestHelper,
    credentials: ICredentialDataDecryptedObject,
  ): Promise<IDataObject> {
    const state = keyState(credentials);
    const run = async () => await refreshKeys(this, credentials, state);
    const result = state.queue.then(run, run);
    state.queue = result.catch(() => undefined);
    return await result;
  }

  // A 2xx means the service key is live. The base URL drops a pasted Admin UI path, like
  // clusterBaseUrl().
  test: ICredentialTestRequest = {
    request: {
      method: 'GET',
      baseURL: `={{($credentials.clusterUrl || "${DEFAULT_CLUSTER_URL}").split("/runtime-management")[0]}}`,
      url: '/runtime-management/environments',
    },
    rules: [
      {
        type: 'responseCode',
        properties: {
          value: 401,
          message:
            'The cluster does not know this service key. Create one in the Admin UI: Service accounts → n8n → Create key.',
        },
      },
      {
        type: 'responseCode',
        properties: {
          value: 403,
          message:
            'The cluster refused this service key: it is wrong, revoked or has no rights. Create one in the Admin UI: Service accounts → n8n → Create key.',
        },
      },
      {
        type: 'responseCode',
        properties: {
          value: 404,
          message:
            'Nothing answers as a Leapter Runtime Cluster at this address. Check the Leapter Server under Advanced Settings.',
        },
      },
    ],
  };
}
