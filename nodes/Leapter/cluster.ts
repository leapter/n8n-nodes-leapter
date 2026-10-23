import type { IExecuteFunctions, ILoadOptionsFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Refuses any address that is not https://, except on this machine
 */
export function assertHttps(ctx: Context, url: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  const local = parsed?.hostname === 'localhost' || parsed?.hostname === '127.0.0.1';
  if (parsed?.protocol !== 'https:' && !local) {
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
  const clusterUrl = String(credentials.clusterUrl ?? '').replace(/\/+$/, '');
  assertHttps(ctx, clusterUrl);
  return clusterUrl;
}

/**
 * The address the cluster answers runs on, from its public config.json.
 * Same rule as the CLI (`apps/cli/src/commands/control-plane/cluster-config.ts` in genielabs):
 * 404 or 410 means the cluster serves no Admin UI and answers runs on its own origin.
 */
export async function readRunBase(ctx: Context, clusterUrl: string): Promise<string> {
  const notACluster = () =>
    new NodeOperationError(
      ctx.getNode(),
      `The cluster at ${clusterUrl} did not answer as a Runtime Cluster.`,
    );

  let origin: string;
  try {
    origin = new URL(clusterUrl).origin;
  } catch {
    throw notACluster();
  }
  if (origin === 'null') {
    throw notACluster();
  }

  let document: unknown;
  try {
    document = await ctx.helpers.httpRequest({
      method: 'GET',
      url: `${origin}/runtime-management/ui/config.json`,
      json: true,
      disableFollowRedirect: true,
    });
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 410) {
      return origin;
    }
    if (status !== undefined) {
      throw notACluster();
    }
    throw new NodeApiError(ctx.getNode(), error as JsonObject);
  }

  if (
    typeof document !== 'object' ||
    document === null ||
    typeof (document as { apiBasePath?: unknown }).apiBasePath !== 'string'
  ) {
    throw notACluster();
  }

  const runBaseUrl = (document as { runBaseUrl?: unknown }).runBaseUrl;
  if (runBaseUrl === undefined || runBaseUrl === null) {
    return origin;
  }
  if (typeof runBaseUrl !== 'string') {
    throw notACluster();
  }
  return runBaseUrl.trim().replace(/\/+$/, '') || origin;
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
  detail?: unknown;
  title?: unknown;
  errors?: Array<{ field?: unknown; message?: unknown }>;
  properties?: { exception?: { type?: unknown } };
}

/**
 * A message for a cluster answer that tells a wrong key, a not yet served application and a
 * blueprint error apart. Error shapes: genielabs `apps/runtime/src/utils/validation.ts` (400) and
 * `apps/runtime/src/http/execute-handler.ts` (500).
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
      return 'The cluster refused the service key. It was revoked or has no rights here. Create a new key in the Admin UI: Service accounts → n8n → Create key.';
    case 401:
      return "The project's access key is not active yet or was revoked. Try again in a minute.";
    case 404:
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
