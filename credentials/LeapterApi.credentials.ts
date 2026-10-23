import type {
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IDataObject,
  IHttpRequestHelper,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';
import { GRACE_MS, lastUsed, parseKeyMap, pending } from './eval-keys';

/**
 * Leapter's hosted cluster. n8n leaves `clusterUrl` out of the credential data while Advanced
 * Settings is off, so every reader falls back to this (also in nodes/Leapter/cluster.ts).
 */
const DEFAULT_CLUSTER_URL = 'https://runtime.leapter.com';

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
      typeOptions: { expirable: true },
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

    const path = pathOf((requestOptions.baseURL ?? '') + requestOptions.url);

    if (path.includes('/runtime-management/')) {
      headers.Authorization = `Bearer ${credentials.serviceKey as string}`;
    } else {
      const match = path.match(/\/runtime\/api\/v1\/([^/]+)\/([^/]+)\//);
      if (match) {
        const project = `${match[1]}/${match[2]}`;
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
    const clusterUrl = String(credentials.clusterUrl || DEFAULT_CLUSTER_URL).replace(/\/+$/, '');
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

    for (const project of [...pending]) {
      if (!map[project]) {
        await mint(project);
      }
      pending.delete(project);
    }

    // The 401 belongs to the request authenticated last. Replace its key only when that key is
    // past the grace period and still the stored one; other projects' keys are left alone.
    const last = [...lastUsed].sort(([, a], [, b]) => b.at - a.at)[0];
    if (last) {
      const [project, { keyId }] = last;
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

  // A 2xx means the service key is live
  test: ICredentialTestRequest = {
    request: {
      method: 'GET',
      baseURL: `={{$credentials.clusterUrl || "${DEFAULT_CLUSTER_URL}"}}`,
      url: '/runtime-management/environments',
    },
  };
}
