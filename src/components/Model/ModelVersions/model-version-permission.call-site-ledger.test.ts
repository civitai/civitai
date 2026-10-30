import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../../../test/source-scan';
import { stripComments } from '../../../../test/strip-comments';

/**
 * POPULATION GUARD for `useModelVersionPermission`: the set of production callers is closed.
 *
 * Without a `modelVersion` argument the hook fetches `modelVersion.getById` itself, so a new caller
 * on the model page is a new request for data the page already holds. This ledger makes adding (or
 * removing) a caller a deliberate edit: it fails on GROWTH and on SHRINK.
 *
 * It deliberately does NOT check that each caller passes `modelVersion`: a source match on the key is
 * satisfied by `modelVersion: undefined` and is automatically true for the two callers that only
 * forward an optional prop, so it would read as coverage while providing none. What the hook does
 * with page data (no `modelVersion.getById` request, correct permissions) is pinned behaviourally in
 * `model-version-permission-page-data.test.ts`; that the page actually hands the data in is not
 * pinned by any test.
 */

const ROOT = process.cwd();

const CALL_SITE_LEDGER: Record<string, string> = {
  'src/pages/models/[id]/[[...slug]].tsx':
    'model page — feeds the selected version from model.getById; never fetches.',
  'src/components/Model/ModelVersions/ModelVersionDetails.tsx':
    'model page body — feeds the version + model props it is rendered with; never fetches.',
  'src/components/Model/ModelVersions/ModelVersionDonationGoal.tsx':
    'forwards its optional modelVersion prop; ModelVersionDetails fills it on the model page.',
  'src/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase.tsx':
    'forwards its optional modelVersion prop: filled when opened from the model page, absent ' +
    'when opened from the generator (the one path that still fetches).',
};

const FILES = sourceFiles(ROOT);
const CODE = new Map(
  FILES.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const)
);
const HOME = 'src/components/Model/ModelVersions/model-version.utils.ts';
const CALL_RE = /\buseModelVersionPermission\s*\(/;
const CALLERS = FILES.filter((f) => f !== HOME && CALL_RE.test(CODE.get(f)!)).sort();

describe('useModelVersionPermission call-site ledger', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain(HOME);
    expect(CALLERS.length).toBeGreaterThan(0);
    // …and that it can go RED: a definitely-absent identifier matches nothing.
    const bogus = FILES.filter((f) => /\buseModelVersionPermissionNoSuch\s*\(/.test(CODE.get(f)!));
    expect(bogus).toEqual([]);
  });

  it('the set of production callers EXACTLY equals the ledger', () => {
    expect(CALLERS).toEqual(Object.keys(CALL_SITE_LEDGER).sort());
  });
});
