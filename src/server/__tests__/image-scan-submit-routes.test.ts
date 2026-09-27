import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const API_ROOT = path.resolve(__dirname, '../../pages/api');

const SCAN_SUBMIT =
  /\b(ingestImages?|ingestImageById|enqueueImageIngestion|createImageIngestionRequest)\b/;

/**
 * REST routes that name an image scan submit function directly. Adding one is a deliberate
 * decision; prefer the `image.rescan` procedure. This sees direct references only, not routes
 * that reach a scan through a service such as `createImage`.
 */
const SCAN_SUBMIT_ROUTES = [
  'admin/rescan-images.ts',
  'media/ingest/[mediaId].ts',
  'webhooks/run-jobs/[[...run]].ts', // the ingest-images job
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('image scan submit functions named by REST routes', () => {
  it('are named only by the recorded routes', () => {
    const found = walk(API_ROOT)
      .filter((file) => SCAN_SUBMIT.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(API_ROOT, file).split(path.sep).join('/'))
      .sort();

    expect(
      found,
      'The set of routes under src/pages/api naming an image scan submit function changed. ' +
        'Record a new one deliberately; delete the line of one that was removed.'
    ).toEqual([...SCAN_SUBMIT_ROUTES].sort());
  });
});
