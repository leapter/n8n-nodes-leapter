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
