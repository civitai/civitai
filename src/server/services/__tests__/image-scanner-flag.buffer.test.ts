import { describe, expect, it } from 'vitest';

// Regression: `isImageScannerNewEnabled` reads a kill-switch from sysRedis and
// compared the reply against the literals '1'/'true'/'0'/'false'. The
// HA/Sentinel sysRedis returns a Buffer for BLOB_STRING replies, which matched
// none of the four literals → the function fell through and DESTRUCTIVELY
// overwrote the operator's '1' with 'false' (then returned false). The pure
// decision is extracted into its own `image-scanner-flag` module so the
// coercion + the seed-only-on-genuinely-unset behavior is testable without
// loading the 7.9K-line image.service module (which drags in Prisma/env/auth
// at import time and can't load under vitest). null return == "unset" == the
// only case the caller is allowed to default-seed.

import { parseScannerFlag } from '~/server/services/image-scanner-flag';

describe('parseScannerFlag — sysRedis Buffer-vs-string flag', () => {
  it('Buffer("1") → true (was a destructive fall-through pre-fix)', () => {
    expect(parseScannerFlag(Buffer.from('1', 'utf8'))).toBe(true);
  });

  it('Buffer("true") → true', () => {
    expect(parseScannerFlag(Buffer.from('true', 'utf8'))).toBe(true);
  });

  it('Buffer("0") → false', () => {
    expect(parseScannerFlag(Buffer.from('0', 'utf8'))).toBe(false);
  });

  it('Buffer("false") → false', () => {
    expect(parseScannerFlag(Buffer.from('false', 'utf8'))).toBe(false);
  });

  it('string "1"/"true" → true (legacy single-pod, unchanged)', () => {
    expect(parseScannerFlag('1')).toBe(true);
    expect(parseScannerFlag('true')).toBe(true);
  });

  it('string "0"/"false" → false (legacy single-pod, unchanged)', () => {
    expect(parseScannerFlag('0')).toBe(false);
    expect(parseScannerFlag('false')).toBe(false);
  });

  it('null → null (genuinely unset → caller seeds the default)', () => {
    expect(parseScannerFlag(null)).toBeNull();
  });

  it('an unrecognized value → null (treated as unset, not a destructive match)', () => {
    expect(parseScannerFlag(Buffer.from('garbage', 'utf8'))).toBeNull();
    expect(parseScannerFlag('garbage')).toBeNull();
  });
});
