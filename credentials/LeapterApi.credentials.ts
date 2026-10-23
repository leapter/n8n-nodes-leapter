import type {
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';

/**
 * Evaluation keys per project, keyed by `<environment>/<application>`
 */
type EvalKeyMap = Record<string, { id: string; key: string; mintedAt: number }>;

function parseKeyMap(raw: unknown): EvalKeyMap {
  if (typeof raw !== 'string' || raw === '') {
    return {};
  }
  try {
    return JSON.parse(raw) as EvalKeyMap;
  } catch {
    return {};
  }
}

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
      displayName: 'Cluster URL',
      name: 'clusterUrl',
      type: 'string',
      default: 'https://runtime.leapter.com',
      required: true,
      description:
        "Your Runtime Cluster's address: the Admin UI's address without /runtime-management/ui. Keep the default for Leapter's hosted cluster.",
    },
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
      const entry = match ? parseKeyMap(credentials.evalKeys)[`${match[1]}/${match[2]}`] : undefined;
      if (entry) {
        headers['X-API-Key'] = entry.key;
      }
    }

    return { ...requestOptions, headers };
  }

  // A 2xx means the service key is live
  test: ICredentialTestRequest = {
    request: {
      method: 'GET',
      baseURL: '={{$credentials.clusterUrl}}',
      url: '/runtime-management/environments',
    },
  };
}
