/**
 * Bulk operation utility for ClickUp skill.
 *
 * Splits comma-separated IDs and runs an async operation on each,
 * with concurrency control to respect ClickUp rate limits.
 *
 * Usage:
 *   import { bulkExecute, splitIds } from './bulk.mjs';
 *
 *   const ids = splitIds('abc,def,ghi');
 *   const results = await bulkExecute(ids, id => getTask(id));
 *   // results = { succeeded: [...], failed: [...], total: 3 }
 */

const DEFAULT_CONCURRENCY = 5;

/**
 * Split a comma-separated string of IDs into an array.
 * Returns a single-element array if no commas are present.
 * Trims whitespace and filters empty strings.
 */
export function splitIds(input) {
  if (!input) return [];
  return input.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Returns true if the input contains multiple IDs (has commas).
 */
export function isBulk(input) {
  return input && input.includes(',');
}

/**
 * Execute an async function on each item with concurrency control.
 *
 * @param {string[]} items - Array of IDs or values to process
 * @param {(item: string) => Promise<any>} fn - Async function to run per item
 * @param {object} [options]
 * @param {number} [options.concurrency=5] - Max parallel operations
 * @returns {{ succeeded: Array<{id, result}>, failed: Array<{id, error}>, total: number }}
 */
export async function bulkExecute(items, fn, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const succeeded = [];
  const failed = [];

  // Process in chunks of `concurrency`
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (item) => {
        const result = await fn(item);
        return { id: item, result };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        succeeded.push(r.value);
      } else {
        // Extract the item ID from the error context
        const id = chunk[results.indexOf(r)];
        failed.push({ id, error: r.reason?.message || String(r.reason) });
      }
    }
  }

  return { succeeded, failed, total: items.length };
}

/**
 * Format bulk results for CLI output.
 *
 * @param {{ succeeded, failed, total }} results
 * @param {object} [options]
 * @param {string} [options.action='Processed'] - Past-tense verb for output
 * @param {(item: {id, result}) => string} [options.formatItem] - Format each success line
 */
export function formatBulkResults(results, { action = 'Processed', formatItem } = {}) {
  const lines = [];

  if (results.succeeded.length > 0) {
    if (formatItem) {
      for (const item of results.succeeded) {
        lines.push(formatItem(item));
      }
    } else {
      lines.push(`${action} ${results.succeeded.length}/${results.total} items.`);
    }
  }

  if (results.failed.length > 0) {
    lines.push(`Failed (${results.failed.length}):`);
    for (const f of results.failed) {
      lines.push(`  ${f.id}: ${f.error}`);
    }
  }

  return lines.join('\n');
}
