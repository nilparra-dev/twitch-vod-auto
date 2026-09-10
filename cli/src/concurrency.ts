/**
 * Run `run` over `items` with at most `limit` executions in flight. The
 * callback shape favors fire-and-forget work such as network probes.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item === undefined) continue;
      await run(item);
    }
  });
  await Promise.all(workers);
}
