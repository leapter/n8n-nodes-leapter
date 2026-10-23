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
