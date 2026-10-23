/**
 * Evaluation keys per project, keyed by `<environment>/<application>`
 */
export type EvalKeyMap = Record<string, { id: string; key: string; mintedAt: number }>;

/**
 * A key younger than this may still answer 401 while the engines pick it up; never replace it
 */
export const GRACE_MS = 90_000;

/**
 * Side channel from authenticate to preAuthentication: n8n gives preAuthentication only the
 * credential data, never the request that failed.
 */
// Projects requested without a key
export const pending = new Set<string>();
// Key sent last per project
export const lastUsed = new Map<string, { keyId: string; at: number }>();
// Project of the engine request authenticated last, with or without a key
export const lastRequested: { project?: string } = {};

/**
 * Leapter's hosted cluster. n8n leaves the credential's `clusterUrl` out while Advanced Settings is
 * off, so every reader goes through clusterBaseUrl().
 */
export const DEFAULT_CLUSTER_URL = 'https://runtime.leapter.com';

/**
 * The credential's cluster address: the default when unset, without trailing slashes and without
 * a pasted Admin UI path (`/runtime-management/…`)
 */
export function clusterBaseUrl(raw: unknown): string {
  const url = String(raw || DEFAULT_CLUSTER_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/runtime-management(\/.*)?$/, '');
  return url || DEFAULT_CLUSTER_URL;
}

/**
 * Whether a key may be sent to this address: https://, or http:// on this machine only
 */
export function isSecureAddress(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
  );
}

export function parseKeyMap(raw: unknown): EvalKeyMap {
  if (typeof raw !== 'string' || raw === '') {
    return {};
  }
  try {
    return JSON.parse(raw) as EvalKeyMap;
  } catch {
    return {};
  }
}
