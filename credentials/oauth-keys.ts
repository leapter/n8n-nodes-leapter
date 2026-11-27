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

/**
 * Shared by provisioning and preAuthentication; never share keys between sign-ins or clusters.
 * The id token names the sign-in: it is never sent, and it survives refresh, because n8n merges a
 * refresh answer into the stored token data and the sign-in server returns no new id token there.
 * Reconnect brings a new one; Disconnect removes it.
 */
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

/**
 * Whether a JWT expires within a minute (clock skew and request time). False when it carries no
 * readable `exp`: the cluster's 401 then starts the refresh.
 */
export function expiresSoon(jwt: unknown): boolean {
	if (typeof jwt !== 'string') return false;
	try {
		const parts = jwt.split('.');
		if (parts.length !== 3) return false;
		const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp?: number };
		return typeof exp === 'number' && Number.isFinite(exp) && Date.now() / 1000 >= exp - 60;
	} catch {
		return false;
	}
}
