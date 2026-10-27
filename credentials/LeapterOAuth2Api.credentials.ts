import type {
	ICredentialDataDecryptedObject,
	ICredentialType,
	IDataObject,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';
import { DEFAULT_CLUSTER_URL } from './eval-keys';
import { oauthKeys, tokenData } from './oauth-keys';

// Public values published by the hosted cluster's runtime-management/ui/config.json.
const SIGN_IN_SERVER = 'https://yyahhgbxjvmqtdbgqgiy.supabase.co/auth/v1';
const CLIENT_ID = '27429955-4cf8-4cfe-bcc7-fc2fb57989d6';
const stageValue = (production: string, custom: string) =>
	`={{ $self["stage"] === "custom" ? ${custom} : "${production}" }}`;
const customServer = '($self["customSignInServer"] || "").trim().replace(/\\/+$/, "")';

export class LeapterOAuth2Api implements ICredentialType {
	name = 'leapterOAuth2Api';
	extends = ['oAuth2Api'];
	displayName = 'Leapter OAuth2 API';
	documentationUrl = 'https://github.com/leapter/n8n-nodes-leapter#readme';
	icon = { light: 'file:leapter.svg', dark: 'file:leapter.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName:
				'Sign-in works only on n8n installs registered with Leapter. To register yours, send Leapter the OAuth Redirect URL above, or use Service Account Key instead.',
			name: 'registrationNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Stage',
			name: 'stage',
			type: 'options',
			options: [
				{ name: 'Production', value: 'production' },
				{ name: 'Custom', value: 'custom' },
			],
			default: 'production',
		},
		{
			displayName: 'Leapter Server',
			name: 'customClusterUrl',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { stage: ['custom'] } },
		},
		{
			displayName: 'Run Address',
			name: 'customRunUrl',
			type: 'string',
			default: '',
			placeholder: 'Same as the Leapter Server',
			displayOptions: { show: { stage: ['custom'] } },
		},
		{
			displayName: 'Sign-in Server',
			name: 'customSignInServer',
			type: 'string',
			default: '',
			required: true,
			hint: 'Copy Sign-in Server and Client ID from cliOidc in &lt;Leapter Server&gt;/runtime-management/ui/config.json.',
			displayOptions: { show: { stage: ['custom'] } },
		},
		{
			displayName: 'Client ID',
			name: 'customClientId',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { stage: ['custom'] } },
		},
		{ displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'pkce' },
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: stageValue(
				`${SIGN_IN_SERVER}/oauth/authorize`,
				`${customServer} + "/oauth/authorize"`,
			),
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: stageValue(`${SIGN_IN_SERVER}/oauth/token`, `${customServer} + "/oauth/token"`),
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: stageValue(CLIENT_ID, '($self["customClientId"] || "").trim()'),
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'hidden',
			typeOptions: { password: true },
			default: '',
		},
		{ displayName: 'Scope', name: 'scope', type: 'hidden', default: 'openid email profile' },
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{ displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'header' },
		{
			displayName: 'Leapter Server',
			name: 'clusterUrl',
			type: 'hidden',
			default: stageValue(DEFAULT_CLUSTER_URL, '$self["customClusterUrl"]'),
		},
		{
			displayName: 'Run Address',
			name: 'runUrl',
			type: 'hidden',
			default: stageValue('', '$self["customRunUrl"] || ""'),
		},
	];

	// n8n >= 2.27 merges this into oauthTokenData during refresh and stores it encrypted.
	// Provisioning creates the keys; this hook only carries them through refresh and reconnect.
	async preAuthentication(
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	): Promise<IDataObject> {
		return {
			oauthTokenData: { ...tokenData(credentials), leapter_eval_keys: oauthKeys(credentials) },
		};
	}
}
