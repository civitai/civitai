import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const API_ROOT = path.resolve(__dirname, '../../pages/api');

const SCAN_SUBMIT =
  /\b(ingestImage|ingestImageById|enqueueImageIngestion|createImageIngestionRequest)\b/;

/**
 * Every REST route that can submit an image scan. Each is operator-only and loads the media URL
 * from the Image row rather than the request. Before adding a route here, keep both properties,
 * or use the `image.rescan` procedure instead.
 */
const SCAN_SUBMIT_ROUTES = [
  'admin/rescan-images.ts', // WebhookEndpoint, ingestImageById
  'media/ingest/[mediaId].ts', // moderator or webhook token, URL from the Image row
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

describe('image scan submission from REST routes', () => {
  it('is reachable only from the recorded operator routes', () => {
    const found = walk(API_ROOT)
      .filter((file) => SCAN_SUBMIT.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(API_ROOT, file).split(path.sep).join('/'))
      .sort();

    expect(found.length).toBeGreaterThan(0);
    expect(
      found,
      'A route under src/pages/api reaches the image scan submit. Record it here only if it is ' +
        'operator-only and loads the URL from the Image row; if a route was removed, delete its line.'
    ).toEqual([...SCAN_SUBMIT_ROUTES].sort());
  });
});
