import { describe, expect, it } from 'vitest';
import { identifierUsers, importersOf } from '../../apps/__tests__/import-ledger';

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

  // The storage info route and the running app's notice read the ceiling through the store
  // (`store.viewerLimits`), the same function its write charge applies.
  it('the storage ceiling: the stores that charge writes and the account storage card read it', () => {
    expect(importersOf(CAPS, 'docStoreUserLimits')).toEqual([
      'server/services/apps/doc-store-maintenance.instance.ts',
      'server/services/apps/doc-store-viewer-usage.service.ts',
      'server/services/apps/doc-store.instance.ts',
    ]);
  });

  // The sleeping-app plan limits: the hibernation service's wiring reads them for `begin` and
  // `commit` alike, so the limit refused at one is the limit refused at the other.
  it('the sleeping-app limits: only the hibernation wiring reads them', () => {
    expect(importersOf(CAPS, 'sleepingAppLimits')).toEqual([
      'server/services/app-hibernation/hibernation-deps.ts',
    ]);
  });

  it('nothing else imports the resolver module', () => {
    expect(importersOf(CAPS)).toEqual([
      'server/routers/blocks.router.ts',
      // A type import only (`SleepingAppLimits`).
      'server/services/app-hibernation/app-hibernation.service.ts',
      'server/services/app-hibernation/hibernation-deps.ts',
      'server/services/apps/doc-store-maintenance.instance.ts',
      'server/services/apps/doc-store-viewer-usage.service.ts',
      'server/services/apps/doc-store.instance.ts',
      'server/services/blocks/app-buzz-usage.service.ts',
    ]);
  });

  // The pre-tier constant is gone, not merely unimported: an import ledger cannot see a use
  // beside the declaration (the consent-budget max read it in its own file), so this scans every
  // identifier in src.
  it('no code names the pre-tier daily Buzz cap constant at all', () => {
    expect(identifierUsers('BLOCK_BUZZ_CAP_PER_DAY')).toEqual([]);
  });

  // POSITIVE CONTROL for the scan above: it sees a same-file use (the declaration's own file)
  // and an importer, so an empty answer is not a scan that sees nothing.
  it('the identifier scan sees a declaration file and its importers', () => {
    const users = identifierUsers('BLOCK_CONSENT_BUDGET_MAX_PER_DAY');
    expect(users).toContain('shared/constants/block-scope.constants.ts');
    expect(users).toContain('server/routers/blocks.router.ts');
  });

  // An identifier scan, not the import ledger: a dynamic `import()` counts as every binding in
  // the ledger, so a file reading this through one could hide behind an unrelated destructure.
  it('only the store module reads the default doc-store limits (its app ceilings and its no-resolver fallback)', () => {
    expect(identifierUsers('DEFAULT_DOC_STORE_LIMITS')).toEqual([
      'server/services/apps/doc-store.ts',
      'server/services/apps/doc-store.types.ts',
    ]);
  });
});
