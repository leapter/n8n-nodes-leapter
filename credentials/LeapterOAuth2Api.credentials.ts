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
const connectionValue = (production: string, custom: string) =>
	`={{ $self["showAdvanced"] === true ? ${custom} : "${production}" }}`;
const signInServer = '($self["customSignInServer"] || "").trim().replace(/\\/+$/, "")';

export class LeapterOAuth2Api implements ICredentialType {
	name = 'leapterOAuth2Api';
	extends = ['oAuth2Api'];
	displayName = 'Leapter OAuth2 API';
	documentationUrl = 'https://github.com/leapter/n8n-nodes-leapter#readme';
	icon = { light: 'file:leapter.svg', dark: 'file:leapter.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName:
				'For Leapter SaaS, send Leapter the OAuth Redirect URL above to enable sign-in. For self-hosted Leapter, ask your administrator to register this URL with your sign-in server. Alternatively, use Service Account Key.',
			name: 'registrationNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Advanced Settings',
			name: 'showAdvanced',
			type: 'boolean',
			default: false,
			description:
				'Whether to configure server and sign-in settings for another Leapter installation. Turning this off resets them to hosted Leapter when saved.',
		},
		{
			displayName: 'Leapter Server',
			name: 'customClusterUrl',
			type: 'string',
			default: DEFAULT_CLUSTER_URL,
			required: true,
			description: 'The Leapter Runtime Cluster. Only change for self-hosted clusters or development.',
			displayOptions: { show: { showAdvanced: [true] } },
		},
		{
			displayName: 'Run Address',
			name: 'customRunUrl',
			type: 'string',
			default: '',
			placeholder: 'Same as the Leapter Server',
			description: 'Where the cluster answers blueprint runs. Leave empty to use the Leapter Server.',
			displayOptions: { show: { showAdvanced: [true] } },
		},
		{
			displayName: 'Sign-in Server',
			name: 'customSignInServer',
			type: 'string',
			default: SIGN_IN_SERVER,
			required: true,
			description: 'The identity provider used to sign in to this cluster',
			hint: 'Copy Sign-in Server and Client ID from cliOidc in &lt;Leapter Server&gt;/runtime-management/ui/config.json.',
			displayOptions: { show: { showAdvanced: [true] } },
		},
		{
			displayName: 'Client ID',
			name: 'customClientId',
			type: 'string',
			default: CLIENT_ID,
			required: true,
			description: 'The public OAuth client identifier for this cluster',
			displayOptions: { show: { showAdvanced: [true] } },
		},
		{ displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'pkce' },
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: connectionValue(
				`${SIGN_IN_SERVER}/oauth/authorize`,
				`${signInServer} + "/oauth/authorize"`,
			),
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: connectionValue(`${SIGN_IN_SERVER}/oauth/token`, `${signInServer} + "/oauth/token"`),
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: connectionValue(CLIENT_ID, '($self["customClientId"] || "").trim()'),
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
			default: connectionValue(DEFAULT_CLUSTER_URL, '$self["customClusterUrl"]'),
		},
		{
			displayName: 'Run Address',
			name: 'runUrl',
			type: 'hidden',
			default: connectionValue('', '$self["customRunUrl"] || ""'),
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
