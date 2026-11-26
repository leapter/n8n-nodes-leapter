import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  IHttpRequestOptions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import {
  PROVISION_HEADER,
  clusterBaseUrl,
  currentKeys,
  isSecureAddress,
} from '../../credentials/eval-keys';
import { expiresSoon, oauthKeys, oauthKeyState, tokenData } from '../../credentials/oauth-keys';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

const SIGN_IN_REQUIRED = 'The Leapter credential is not connected. Open the credential and connect.';
const SIGN_IN_NOT_RENEWED =
  'The Leapter sign-in could not be renewed. Open the credential and reconnect.';
const NO_ID_TOKEN =
  'The Leapter sign-in has no id token, which project access needs. Check that the sign-in server issues one for the openid scope, then reconnect.';

/** Longest `usedBy` the cluster takes, in characters */
const MAX_USED_BY_LENGTH = 64;

/** Read the saved option directly: older workflows have no authentication parameter. */
export function credentialTypeOf(ctx: Context): 'leapterApi' | 'leapterOAuth2Api' {
  return ctx.getNode().parameters.authentication === 'oAuth2' ? 'leapterOAuth2Api' : 'leapterApi';
}

/**
 * Refuses any address that is not https://, except on this machine
 */
export function assertHttps(ctx: Context, url: string): void {
  if (!isSecureAddress(url)) {
    throw new NodeOperationError(
      ctx.getNode(),
      `The address ${url} is not https://. Only localhost may be reached without it.`,
    );
  }
}

/**
 * The credential's cluster address without a trailing slash, checked for https
 */
export async function clusterUrlOf(ctx: Context): Promise<string> {
  const credentials = await ctx.getCredentials(credentialTypeOf(ctx));
  const clusterUrl = clusterBaseUrl(credentials.clusterUrl);
  assertHttps(ctx, clusterUrl);
  return clusterUrl;
}

/**
 * Creates and saves a missing OAuth key directly. With a service key, n8n creates keys only in
 * the credential's preAuthentication, which every version since 2.0 runs while the credential holds
 * no key and after a 401. A project that has never had a key is not served: its engine answers 404,
 * not 401. So while the credential holds keys of other projects but not this one, one request goes
 * to the engine of a project it holds a key for, marked with this project (PROVISION_HEADER), and
 * authenticate sends it without a key: that engine answers 401, and preAuthentication creates this
 * project's key. While the credential holds no key at all, the marked request only names the
 * project, and the next request's preAuthentication creates the key.
 */
export async function provisionKey(
  ctx: Context,
  runBase: string,
  environment: string,
  application: string,
): Promise<void> {
  if (credentialTypeOf(ctx) === 'leapterOAuth2Api') {
    return await provisionOAuthKey(ctx, environment, application);
  }
  const project = `${environment}/${application}`;
  const keys = currentKeys(await ctx.getCredentials('leapterApi'));
  if (keys[project]) {
    return;
  }
  const via = Object.keys(keys)[0] ?? project;
  try {
    await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'leapterApi', {
      method: 'GET',
      url: `${runBase}/runtime/api/v1/${via}/openapi`,
      headers: { [PROVISION_HEADER]: project },
      json: true,
      disableFollowRedirect: true,
    });
  } catch (error) {
    // 401 and 404 are expected (the key activates, or that project is gone); the request that
    // follows reports them. Anything else is preAuthentication's refusal to create the key (a 403
    // for an environment without rights) or an unreachable cluster: waiting cannot help.
    const status = answerOf(error)?.status;
    if (status !== 401 && status !== 404) {
      throw new NodeApiError(ctx.getNode(), error as JsonObject);
    }
  }
}

/** Serialize mint + save so overlapping prewarm, field loads and runs do not lose keys. */
async function provisionOAuthKey(
  ctx: Context,
  environment: string,
  application: string,
): Promise<void> {
  const credentials = await ctx.getCredentials('leapterOAuth2Api');
  const state = oauthKeyState(credentials);
  const run = async () => {
    const project = `${environment}/${application}`;
    if (!oauthKeys(credentials)[project]) {
      // The id token names the sign-in that keeps new keys until they are saved
      // (oauthKeyState). Without one, a new key would be lost and created again.
      const token = tokenData(credentials);
      if (typeof token.id_token !== 'string' && typeof token.access_token === 'string') {
        throw new NodeOperationError(ctx.getNode(), NO_ID_TOKEN);
      }
      const cluster = clusterBaseUrl(credentials.clusterUrl);
      assertHttps(ctx, cluster);
      const answer = (await oauthManagementRequest(ctx, {
        method: 'POST',
        url: `${cluster}/runtime-management/environments/${environment}/applications/${application}/keys`,
        body: { reason: 'n8n node (sign in)', usedBy: usedByOf(ctx) },
        json: true,
      })) as { key: string; credential: { id: string } };
      state.latest[project] = {
        id: answer.credential.id,
        key: answer.key,
        mintedAt: Date.now(),
        cluster,
      };
      state.unsaved = true;
    }
    if (state.unsaved) {
      try {
        const saved = await ctx.helpers.refreshOAuth2Token.call(ctx, 'leapterOAuth2Api');
        // n8n may reuse another concurrent refresh without running preAuthentication. Do not
        // claim persistence unless its returned token data contains every key we just created.
        if (
          Object.entries(state.latest).some(
            ([project, entry]) => saved?.leapter_eval_keys?.[project]?.key !== entry.key,
          )
        ) {
          throw new Error('The refreshed credential did not retain the evaluation keys.');
        }
        state.unsaved = false;
      } catch {
        // Retain the new key and retry saving it on the next use, without minting another one.
        throw new NodeOperationError(
          ctx.getNode(),
          `The access key for ${application} could not be saved. Open the credential and reconnect, then try again.`,
        );
      }
    }
  };
  const result = state.queue.then(run, run);
  state.queue = result.catch(() => undefined);
  await result;
}

/**
 * The label of an OAuth key in the cluster's key list: `n8n: <credential name>`, so keys of two
 * credentials can be told apart. One line of at most 64 characters, as the cluster requires.
 */
function usedByOf(ctx: Context): string {
  const name = String(ctx.getNode().credentials?.leapterOAuth2Api?.name ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .trim();
  return name ? [...`n8n: ${name}`].slice(0, MAX_USED_BY_LENGTH).join('').trim() : 'n8n';
}

/**
 * Management sends the sign-in's access token itself. n8n's OAuth signing is not used: it would
 * also sign engine requests and refresh on an engine's 401, which means a key that is activating.
 */
export async function controlPlaneRequest(
  ctx: Context,
  options: IHttpRequestOptions,
): Promise<unknown> {
  if (credentialTypeOf(ctx) === 'leapterApi') {
    return await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'leapterApi', options);
  }
  return await oauthManagementRequest(ctx, options);
}

/**
 * The access token for a management request: renewed first when it expires within a minute, or
 * when the cluster refused it (`renew`). A failed early renewal sends the current token anyway
 * (the sign-in server may be briefly away); only a failed renewal after a refusal asks to
 * reconnect.
 */
async function accessToken(ctx: Context, renew = false): Promise<string> {
  const current = tokenData(await ctx.getCredentials('leapterOAuth2Api')).access_token;
  if (typeof current !== 'string' || current === '') {
    throw new NodeOperationError(ctx.getNode(), SIGN_IN_REQUIRED);
  }
  if (!renew && !expiresSoon(current)) {
    return current;
  }
  let renewed: unknown;
  try {
    // Also runs preAuthentication, which keeps the stored evaluation keys
    renewed = (await ctx.helpers.refreshOAuth2Token.call(ctx, 'leapterOAuth2Api'))?.access_token;
  } catch {
    renewed = undefined;
  }
  if (typeof renewed === 'string' && renewed !== '') {
    return renewed;
  }
  if (!renew) {
    return current;
  }
  throw new NodeOperationError(ctx.getNode(), SIGN_IN_NOT_RENEWED);
}

/**
 * A management request with the access token; a 401 renews it and asks once more. Failures
 * cannot become engine activation retries, even for 401 or 404.
 */
async function oauthManagementRequest(
  ctx: Context,
  options: IHttpRequestOptions,
): Promise<unknown> {
  const send = async (token: string): Promise<{ value: unknown } | { error: unknown }> => {
    try {
      return {
        value: await plainRequest(ctx, {
          ...options,
          headers: { ...withoutAuth(options.headers), Authorization: `Bearer ${token}` },
        }),
      };
    } catch (error) {
      return { error };
    }
  };
  let sent = await send(await accessToken(ctx));
  if ('error' in sent && answerOf(sent.error)?.status === 401) {
    sent = await send(await accessToken(ctx, true));
  }
  if ('value' in sent) {
    return sent.value;
  }
  const { error } = sent;
  const answer = answerOf(error);
  let message: string;
  if (answer?.status === 401) {
    message =
      'The cluster rejected the Leapter sign-in. Open the credential and reconnect. If that does not help, check the Client ID, and for a custom installation the Sign-in Server under Advanced Settings.';
  } else if (answer?.status === 403) {
    message =
      'The cluster refused the signed-in account. Check its access to this environment; creating project access keys requires the operator role.';
  } else if (answer?.status === 404) {
    message =
      'The cluster could not find the requested environment, project or management endpoint. Check the selected project and Leapter Server under Advanced Settings.';
  } else {
    message = answer
      ? describeClusterError(answer.status, answer.body, answer.headers)
      : `Leapter management request failed: ${(error as Error).message}`;
  }
  throw new NodeOperationError(ctx.getNode(), message);
}

/** Engine requests carry only a project's evaluation key, even after the sign-in expires. */
export async function engineRequest(
  ctx: Context,
  environment: string,
  application: string,
  options: IHttpRequestOptions,
): Promise<unknown> {
  if (credentialTypeOf(ctx) === 'leapterApi') {
    return await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'leapterApi', options);
  }
  const entry = oauthKeys(await ctx.getCredentials('leapterOAuth2Api'))[`${environment}/${application}`];
  if (!entry) {
    throw new NodeOperationError(ctx.getNode(), `No access key for ${application}.`);
  }
  return await plainRequest(ctx, {
    ...options,
    headers: { ...withoutAuth(options.headers), 'X-API-Key': entry.key },
  });
}

function withoutAuth(headers: IHttpRequestOptions['headers']): IHttpRequestOptions['headers'] {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) =>
      !['authorization', 'x-api-key'].includes(name.toLowerCase()),
    ),
  );
}

async function plainRequest(ctx: Context, options: IHttpRequestOptions): Promise<unknown> {
  assertHttps(ctx, (options.baseURL ?? '') + options.url);
  try {
    return await ctx.helpers.httpRequest({ ...options, disableFollowRedirect: true });
  } catch (error) {
    // Match the service credential's errors, including the existing activation retry handling.
    throw new NodeApiError(ctx.getNode(), error as JsonObject);
  }
}

/**
 * The address runs go to, checked for https: the credential's Run Address, or its Leapter Server
 * when that is empty
 */
export async function runBaseOf(ctx: Context): Promise<string> {
  const credentials = await ctx.getCredentials(credentialTypeOf(ctx));
  const runBase =
    String(credentials.runUrl ?? '')
      .trim()
      .replace(/\/+$/, '') || clusterBaseUrl(credentials.clusterUrl);
  assertHttps(ctx, runBase);
  return runBase;
}

/**
 * Shown when an engine request reaches the control plane: the cluster answers runs on another
 * address than its Leapter Server (a local cluster, on http://localhost:3003)
 */
export const RUN_ADDRESS_MISSING =
  'This cluster answers runs on another address than the Leapter Server. Set Run Address under Advanced Settings in the Leapter credential.';

/**
 * Whether an engine request was answered by the control plane, which knows no engine paths. An
 * engine answers a project it does not serve (yet) with a plain-text 404.
 */
export function isControlPlaneAnswer(error: unknown): boolean {
  const answer = answerOf(error);
  return answer?.status === 404 && isUnknownEndpoint(parseBody(answer.body));
}

function isUnknownEndpoint(problem: ProblemBody | undefined): boolean {
  return String(problem?.type).endsWith('/runtime-management/unknown-endpoint');
}

/**
 * Status, body and headers of an answer on a thrown request error. httpRequestWithAuthentication
 * throws a NodeApiError: httpCode is the status as a string, the axios error is its cause.
 * helpers.httpRequest throws the axios error itself.
 */
export function answerOf(
  error: unknown,
): { status: number; body: unknown; headers: Record<string, unknown> } | undefined {
  const e = error as {
    httpCode?: string | null;
    response?: AxiosLikeResponse;
    cause?: { response?: AxiosLikeResponse };
    context?: { data?: unknown };
  };
  const response = e.cause?.response ?? e.response;
  const status = e.httpCode ? Number(e.httpCode) : response?.status;
  if (!status || Number.isNaN(status)) {
    return undefined;
  }
  return { status, body: response?.data ?? e.context?.data, headers: response?.headers ?? {} };
}

interface AxiosLikeResponse {
  status?: number;
  data?: unknown;
  headers?: Record<string, unknown>;
}

interface ProblemBody {
  type?: unknown;
  detail?: unknown;
  title?: unknown;
  errors?: Array<{ field?: unknown; message?: unknown }>;
  properties?: {
    exception?: { type?: unknown };
    // The blueprint's own errors (the runtime's answer to a failed run)
    errorOutput?: Array<{ detail?: unknown; title?: unknown }>;
  };
}

/**
 * A message for a cluster answer that tells a wrong key, a not yet served application and a
 * blueprint error apart. Error shapes: the runtime's validation errors (400) and failed runs (500).
 */
export function describeClusterError(
  status: number,
  body: unknown,
  headers: Record<string, unknown>,
): string {
  const problem = parseBody(body);
  const detail = typeof problem?.detail === 'string' ? problem.detail : undefined;
  const fallback =
    detail ??
    (typeof problem?.title === 'string' ? problem.title : undefined) ??
    `Request failed with status ${status}`;

  switch (status) {
    case 403:
      // The cluster answers the same for a revoked key and for an environment the key has no
      // rights in (renamed, or its grants changed)
      return 'The cluster refused the request. The service key was revoked, or it has no rights in this environment. Check the key in the Admin UI: Service accounts → n8n.';
    case 401:
      return "The project's access key is not active yet or was revoked. Try again in a minute.";
    case 404:
      if (isUnknownEndpoint(problem)) {
        return RUN_ADDRESS_MISSING;
      }
      if (problem === undefined) {
        return 'The cluster serves nothing at this address yet. A newly deployed project takes about a minute to be reachable.';
      }
      return fallback;
    case 400: {
      const lines = (Array.isArray(problem?.errors) ? problem.errors : []).map(
        (entry) => `${String(entry.field)}: ${String(entry.message)}`,
      );
      return [fallback, ...lines].join('\n');
    }
    case 500: {
      // An error the blueprint raised names its own reason; the exception type adds nothing then
      const errorOutput = problem?.properties?.errorOutput;
      const reasons = (Array.isArray(errorOutput) ? errorOutput : [])
        .map((entry) => entry?.detail || entry?.title)
        .filter((reason): reason is string => typeof reason === 'string' && reason !== '');
      if (reasons.length > 0) {
        return [fallback, ...reasons].join('\n');
      }
      const exception = problem?.properties?.exception?.type;
      return typeof exception === 'string' ? `${fallback}\nException: ${exception}` : fallback;
    }
    case 429:
    case 503: {
      const seconds = retryAfterSeconds(headers['retry-after'] ?? headers['Retry-After']);
      return seconds === undefined ? fallback : `${fallback} Retry after ${seconds} s.`;
    }
    default:
      return fallback;
  }
}

/**
 * A node error for a failed request: the described cluster answer, or `<what>: <message>`
 * when no answer came back
 */
export function clusterError(
  ctx: Context,
  error: unknown,
  what: string,
  itemIndex?: number,
): NodeOperationError {
  const answer = answerOf(error);
  let message = answer
    ? describeClusterError(answer.status, answer.body, answer.headers)
    : `${what}: ${(error as Error).message}`;
  if (answer?.status === 403 && credentialTypeOf(ctx) === 'leapterOAuth2Api') {
    // OAuth management failures already have a NodeOperationError. This is an engine refusal,
    // where the project key, not the signed-in member's role, determines access.
    message =
      "The engine refused the project's access key. Check the project's evaluation key in the Admin UI.";
  }
  return new NodeOperationError(ctx.getNode(), message, { itemIndex });
}

// The body as an object, or undefined when it is not JSON
function parseBody(body: unknown): ProblemBody | undefined {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  return typeof body === 'object' && body !== null ? (body as ProblemBody) : undefined;
}

function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
