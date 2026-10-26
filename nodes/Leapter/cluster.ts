import type { IExecuteFunctions, ILoadOptionsFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import {
  PROVISION_HEADER,
  clusterBaseUrl,
  currentKeys,
  isSecureAddress,
} from '../../credentials/eval-keys';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

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
  const credentials = await ctx.getCredentials('leapterApi');
  const clusterUrl = clusterBaseUrl(credentials.clusterUrl);
  assertHttps(ctx, clusterUrl);
  return clusterUrl;
}

/**
 * Makes n8n create the project's evaluation key before an engine request. n8n creates keys only in
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

/**
 * The address runs go to, checked for https: the credential's Run Address, or its Leapter Server
 * when that is empty
 */
export async function runBaseOf(ctx: Context): Promise<string> {
  const credentials = await ctx.getCredentials('leapterApi');
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
  const message = answer
    ? describeClusterError(answer.status, answer.body, answer.headers)
    : `${what}: ${(error as Error).message}`;
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
