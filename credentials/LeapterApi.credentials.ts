import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

/**
 * Leapter API Key Credential
 *
 * Simple API key authentication for Leapter integrations.
 * Replaces the previous OAuth2 credential with a simpler flow.
 */
export class LeapterApi implements ICredentialType {
  name = 'leapterApi';
  displayName = 'Leapter API';
  documentationUrl = 'https://github.com/leapter/n8n-nodes-leapter#readme';
  icon = 'file:leapter.svg' as const;

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Your Leapter API key. Generate one at Settings → API Keys in Leapter.',
      hint: 'Starts with lpt_',
    },
    {
      displayName: 'Advanced Settings',
      name: 'showAdvanced',
      type: 'boolean',
      default: false,
      description: 'Whether to show advanced settings like server URL',
    },
    {
      displayName: 'Leapter Server',
      name: 'server',
      type: 'string',
      default: 'https://lab.leapter.com',
      description: 'The Leapter server URL. Only change for development or self-hosted instances.',
      displayOptions: {
        show: {
          showAdvanced: [true],
        },
      },
    },
  ];

  // Authentication: Add X-API-Key header to all requests
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        'X-API-Key': '={{$credentials.apiKey}}',
      },
    },
  };

  // Test credentials by validating the API key
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.server}}',
      url: '/api/api-keys/validate',
      method: 'POST',
      body: {
        apiKey: '={{$credentials.apiKey}}',
      },
    },
  };
}
