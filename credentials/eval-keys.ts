/**
 * Evaluation keys per project, keyed by `<environment>/<application>`. `cluster` is the address the
 * key was created at; a key without it counts for the credential's current address.
 */
export type EvalKeyMap = Record<
  string,
  { id: string; key: string; mintedAt: number; cluster?: string }
>;

/**
 * Marks a request of provisionKey() (nodes/Leapter/cluster.ts) with the project that needs a key:
 * authenticate removes it, records the project and sends the request without any key
 */
export const PROVISION_HEADER = 'X-Leapter-Provision';

/**
 * A key younger than this may still answer 401 while the engines pick it up; never replace it
 */
export const GRACE_MS = 90_000;

/**
 * A project requested this recently is a candidate when a 401 makes n8n call preAuthentication
 */
export const RECENT_USE_MS = 120_000;

/**
 * Side channel from authenticate to preAuthentication, per credential (cluster address and
 * service key): n8n gives preAuthentication only the credential data, never the request that
 * failed, and runs requests of several credentials and executions at once.
 */
export interface KeyState {
  // Projects requested without a key
  pending: Set<string>;
  // Projects requested with a key: when, and the engine address that probes the key
  used: Map<string, { at: number; probeUrl: string }>;
  // Project of the engine request authenticated last, with or without a key
  lastRequested?: string;
  // The newest key map preAuthentication returned in this process. n8n may hand a later call an
  // older copy of the credential, read before that map was stored.
  latest: EvalKeyMap;
  // preAuthentication calls of this credential run one at a time
  queue: Promise<unknown>;
}

const states = new Map<string, KeyState>();

export function keyState(credentials: { clusterUrl?: unknown; serviceKey?: unknown }): KeyState {
  const id = `${clusterBaseUrl(credentials.clusterUrl)} ${String(credentials.serviceKey)}`;
  let state = states.get(id);
  if (state === undefined) {
    state = { pending: new Set(), used: new Map(), latest: {}, queue: Promise.resolve() };
    states.set(id, state);
  }
  return state;
}

/**
 * The credential's evaluation keys for its current cluster address: the stored copy, with any
 * newer key this process created since
 */
export function currentKeys(credentials: {
  clusterUrl?: unknown;
  serviceKey?: unknown;
  evalKeys?: unknown;
}): EvalKeyMap {
  const cluster = clusterBaseUrl(credentials.clusterUrl);
  const keys: EvalKeyMap = {};
  for (const map of [parseKeyMap(credentials.evalKeys), keyState(credentials).latest]) {
    for (const [project, entry] of Object.entries(map)) {
      if (entry.cluster !== undefined && entry.cluster !== cluster) {
        continue;
      }
      if (keys[project] === undefined || entry.mintedAt > keys[project].mintedAt) {
        keys[project] = entry;
      }
    }
  }
  return keys;
}

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
