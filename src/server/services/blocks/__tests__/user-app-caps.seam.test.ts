import { describe, expect, it } from 'vitest';
import { importersOf } from '../../apps/__tests__/import-ledger';

/**
 * SEAM: the account Limits section and enforcement read a user's app caps from ONE resolver,
 * `resolveUserAppCaps` (`user-app-caps.service.ts`), so what a user is shown is what is enforced.
 * These cases pin the relationship by parsing every import in src: who reads the resolver, and
 * that nothing reads the pre-tier constants instead. Each fails when its set grows OR shrinks.
 * The behavioural half (a changed tier value moves the enforced cap and the shown cap together)
 * is in `blocks.router.scopeEnforcement.test.ts` and `user-app-caps.service.test.ts`.
 */
const CAPS = 'server/services/blocks/user-app-caps.service';

describe('one resolver for the per-user app caps', () => {
  it('the daily Buzz cap: the reservation (blocks router) and the Limits rows (app Buzz usage) read it', () => {
    expect(importersOf(CAPS, 'resolveUserAppCaps')).toEqual([
      'server/routers/blocks.router.ts',
      'server/services/blocks/app-buzz-usage.service.ts',
    ]);
  });

  it('the storage ceiling: the stores that charge writes, the storage info route and the account storage card read it', () => {
    expect(importersOf(CAPS, 'docStoreUserLimits')).toEqual([
      'server/services/apps/doc-store-api.ts',
      'server/services/apps/doc-store-maintenance.instance.ts',
      'server/services/apps/doc-store-viewer-usage.service.ts',
      'server/services/apps/doc-store.instance.ts',
    ]);
  });

  it('nothing else imports the resolver module', () => {
    expect(importersOf(CAPS)).toEqual([
      'server/routers/blocks.router.ts',
      'server/services/apps/doc-store-api.ts',
      'server/services/apps/doc-store-maintenance.instance.ts',
      'server/services/apps/doc-store-viewer-usage.service.ts',
      'server/services/apps/doc-store.instance.ts',
      'server/services/blocks/app-buzz-usage.service.ts',
    ]);
  });

  // A dynamic `import()` takes every binding, so it is listed: each one below destructures some
  // other export (`REVIEW_RUN_FOR_REAL_BUZZ_CAP`, `isDocStoreError`).
  it('no code reads the pre-tier daily Buzz cap constant in place of the resolver', () => {
    expect(importersOf('shared/constants/block-scope.constants', 'BLOCK_BUZZ_CAP_PER_DAY')).toEqual(
      ['server/services/blocks/publish-request.service.ts']
    );
  });

  it('only the store module reads the default doc-store limits (its app ceilings and its no-resolver fallback)', () => {
    expect(importersOf('server/services/apps/doc-store.types', 'DEFAULT_DOC_STORE_LIMITS')).toEqual(
      [
        'server/services/apps/doc-store.ts',
        'server/services/blocks/publish-request.service.ts',
        'server/services/user.service.ts',
      ]
    );
  });
});
