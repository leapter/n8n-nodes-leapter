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
  clusterBaseUrl,
  isSecureAddress,
  lastRequested,
  lastUsed,
  parseKeyMap,
  pending,
} from './eval-keys';

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
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
  icon = 'file:leapter.svg' as const;

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

    if (path.includes('/runtime-management/')) {
      headers.Authorization = `Bearer ${credentials.serviceKey as string}`;
    } else {
      const match = path.match(/\/runtime\/api\/v1\/([^/]+)\/([^/]+)\//);
      if (match) {
        const project = `${match[1]}/${match[2]}`;
        lastRequested.project = project;
        const entry = parseKeyMap(credentials.evalKeys)[project];
        if (entry) {
          headers['X-API-Key'] = entry.key;
          lastUsed.set(project, { keyId: entry.id, at: Date.now() });
        } else {
          pending.add(project);
        }
      }
    }

    return { ...requestOptions, headers };
  }

  // Runs before the first request and after every 401: creates missing evaluation keys and
  // replaces a rejected one. n8n stores the returned evalKeys in the credential.
  async preAuthentication(
    this: IHttpRequestHelper,
    credentials: ICredentialDataDecryptedObject,
  ): Promise<IDataObject> {
    const clusterUrl = clusterBaseUrl(credentials.clusterUrl);
    const authorization = `Bearer ${credentials.serviceKey as string}`;
    const map = parseKeyMap(credentials.evalKeys);
    const keysUrl = (project: string) => {
      const [environment, application] = project.split('/');
      return `${clusterUrl}/runtime-management/environments/${environment}/applications/${application}/keys`;
    };
    const mint = async (project: string) => {
      const answer = (await this.helpers.httpRequest({
        method: 'POST',
        url: keysUrl(project),
        headers: { Authorization: authorization },
        body: { reason: 'n8n node', usedBy: 'n8n' },
        json: true,
      })) as { key: string; credential: { id: string } };
      map[project] = { id: answer.credential.id, key: answer.key, mintedAt: Date.now() };
    };

    // Each project leaves the queue before its key is created, so a refusal (a project gone, an
    // environment without rights) is not retried for every later request. Only the requested
    // project's refusal fails this request.
    let refusal: unknown;
    for (const project of [...pending]) {
      pending.delete(project);
      if (map[project]) {
        continue;
      }
      try {
        await mint(project);
      } catch (error) {
        if (project === lastRequested.project) {
          refusal = error;
        }
      }
    }
    if (refusal !== undefined) {
      throw refusal;
    }

    // The refusal belongs to the request authenticated last. Replace that project's key only when
    // it was sent, is past the grace period and is still the stored one; a keyless first use
    // never touches another project's key.
    const project = lastRequested.project;
    const used = project ? lastUsed.get(project) : undefined;
    if (project && used) {
      const { keyId } = used;
      const stored = map[project];
      if (stored && stored.id === keyId && Date.now() - stored.mintedAt > GRACE_MS) {
        await mint(project);
        try {
          await this.helpers.httpRequest({
            method: 'POST',
            url: `${keysUrl(project)}/${keyId}/revoke`,
            headers: { Authorization: authorization },
            body: { reason: 'n8n node: replaced' },
            json: true,
          });
        } catch {
          // The replacement works without it; the old key stays until revoked in the Admin UI
        }
      }
    }

    return { evalKeys: JSON.stringify(map) };
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
