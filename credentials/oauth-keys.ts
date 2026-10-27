import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';
import { clusterBaseUrl } from './eval-keys';
import type { EvalKeyMap } from './eval-keys';

interface OAuthKeyState {
	latest: EvalKeyMap;
	unsaved: boolean;
	queue: Promise<unknown>;
}

const states = new Map<string, OAuthKeyState>();

export function tokenData(credentials: ICredentialDataDecryptedObject): IDataObject {
	return (credentials.oauthTokenData ?? {}) as IDataObject;
}

/** Shared by provisioning and preAuthentication; never share keys between sign-ins or clusters. */
export function oauthKeyState(credentials: ICredentialDataDecryptedObject): OAuthKeyState {
	const token = tokenData(credentials).id_token;
	const empty = (): OAuthKeyState => ({ latest: {}, unsaved: false, queue: Promise.resolve() });
	if (typeof token !== 'string' || !token) return empty();
	const id = `${clusterBaseUrl(credentials.clusterUrl)} ${token}`;
	let state = states.get(id);
	if (!state) {
		state = empty();
		states.set(id, state);
	}
	return state;
}

/** Stored keys plus keys created since n8n read this copy of the credential. */
export function oauthKeys(credentials: ICredentialDataDecryptedObject): EvalKeyMap {
	const cluster = clusterBaseUrl(credentials.clusterUrl);
	const stored = (tokenData(credentials).leapter_eval_keys ?? {}) as EvalKeyMap;
	const keys: EvalKeyMap = {};
	for (const map of [stored, oauthKeyState(credentials).latest]) {
		for (const [project, entry] of Object.entries(map)) {
			if (entry.cluster !== undefined && entry.cluster !== cluster) continue;
			if (!keys[project] || entry.mintedAt > keys[project].mintedAt) keys[project] = entry;
		}
	}
	return keys;
}

/** The id token is not renewed by refresh. Leave a minute for clock skew and request time. */
export function idTokenUsable(token: IDataObject): boolean {
	if (typeof token.id_token !== 'string') return false;
	try {
		const parts = token.id_token.split('.');
		if (parts.length !== 3) return false;
		const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp?: number };
		return typeof exp === 'number' && Number.isFinite(exp) && Date.now() / 1000 < exp - 60;
	} catch {
		return false;
	}
}
