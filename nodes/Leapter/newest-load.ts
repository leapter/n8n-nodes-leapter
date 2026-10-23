/**
 * Overlapping field loads of one caller all answer with the newest load's result.
 *
 * n8n never cancels a field request, and a request that waits for an activating key can take a
 * minute. When the user picks another project or blueprint meanwhile, the editor ends its loading
 * state with whichever answer comes first and keeps whichever comes last, even when that one
 * belongs to the old selection. n8n does not say which node asks (every request runs as
 * "Temp-Node", without a workflow id), so the caller is the n8n user and the credential.
 */

// The newest load per caller. Never removed: an older load may still need to follow it.
const newest = new Map<string, { result: Promise<unknown> }>();

/**
 * Runs `load` for `caller`. A load superseded by a newer one of the same caller sees
 * `superseded()` turn true and answers with the newest load's result (or error) instead of its
 * own. Without a caller every load answers for itself.
 */
export async function newestLoad<T>(
  caller: string | undefined,
  load: (superseded: () => boolean) => Promise<T>,
): Promise<T> {
  if (caller === undefined) {
    return await load(() => false);
  }

  const own = {} as { result: Promise<unknown> };
  newest.set(caller, own);
  own.result = load(() => newest.get(caller) !== own);

  // Follow the newest load until the one awaited is still the newest when it ends
  let current = own;
  for (;;) {
    await current.result.catch(() => undefined);
    const latest = newest.get(caller) ?? current;
    if (latest === current) {
      return (await current.result) as T;
    }
    current = latest;
  }
}
