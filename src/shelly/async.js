// -----------------------------------------------------------------------------
// Small async helpers shared by discovery and telemetry.
// -----------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 *
 * Fleets here are LANs: probing 30 Shelly devices all at once floods a cheap
 * router and makes healthy devices look dead through timeouts. A small worker
 * pool keeps the scan fast without that failure mode.
 *
 * Results keep the input order, and a rejected item resolves to `undefined`
 * rather than aborting the batch — one unreachable device must never cost the
 * other twenty-nine.
 *
 * @template T, R
 * @param {T[]} items items to process
 * @param {number} concurrency maximum number of parallel workers
 * @param {(item: T, index: number) => Promise<R>} worker async worker
 * @returns {Promise<Array<R|undefined>>} the results, in input order
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        try {
          results[index] = await worker(items[index], index);
        } catch {
          results[index] = undefined;
        }
      }
    })(),
  );

  await Promise.all(runners);
  return results;
}
