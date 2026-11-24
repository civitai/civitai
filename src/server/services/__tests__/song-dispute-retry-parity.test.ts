import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_RESCAN_RETRY_LIMIT,
  IMAGE_SCAN_PERMANENT_RETRY_LIMIT,
  IMAGE_SCAN_TRANSIENT_RETRY_LIMIT,
  IMAGE_SCAN_UNKNOWN_RETRY_LIMIT,
  ImageScanFailureClass,
} from '~/server/services/image-scan-failure';

// Cross-app parity pin. The moderator app does not import src/, so it copies the ingest cron's retry
// ceilings to tell a song whose scan gave up (its dispute closes as gone) from one due a retry (its
// dispute waits). A drifted copy would close a dispute the cron still retries, or keep one open
// forever.
const MODERATOR = readFileSync(
  path.resolve(__dirname, '../../../../apps/moderator/src/lib/server/rating-reviews.service.ts'),
  'utf8'
);

const constant = (name: string) => {
  const m = MODERATOR.match(new RegExp(`const ${name} = (\\d+);`));
  if (!m) throw new Error(`${name} not found in the moderator rating-reviews service`);
  return Number(m[1]);
};

describe("the moderator's copy of the scan retry ceilings", () => {
  it('matches the main app’s, class by class', () => {
    const limits = MODERATOR.match(/const SCAN_RETRY_LIMITS[^=]*= \{([^}]*)\}/)?.[1];
    expect(limits).toBeDefined();
    const byClass = Object.fromEntries(
      [...(limits ?? '').matchAll(/(\w+): (\d+)/g)].map(([, k, v]) => [k, Number(v)])
    );
    expect(byClass).toEqual({
      [ImageScanFailureClass.Transient]: IMAGE_SCAN_TRANSIENT_RETRY_LIMIT,
      [ImageScanFailureClass.Permanent]: IMAGE_SCAN_PERMANENT_RETRY_LIMIT,
    });
    expect(constant('UNKNOWN_SCAN_RETRY_LIMIT')).toBe(IMAGE_SCAN_UNKNOWN_RETRY_LIMIT);
    expect(constant('RESCAN_RETRY_LIMIT')).toBe(IMAGE_RESCAN_RETRY_LIMIT);
  });
});
