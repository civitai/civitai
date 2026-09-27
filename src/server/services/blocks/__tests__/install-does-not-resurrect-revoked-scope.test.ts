import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

/**
 * 🔴 THE DEFECT THIS WHOLE FEATURE IS SHAPED BY: AN INSTALL MUST NOT RESURRECT A REVOKED
 * SCOPE.
 *
 * `BlockRegistry.recordInstallConsent` passes `consentGatedScopes(effectiveBlockScopes(…))`
 * — the app's ENTIRE consent-gated set, unconditionally, with no consent prompt anywhere —
 * into `recordScopeGrant`, which UNIONS it into `granted_scopes`. So a per-scope revoke
 * modelled as mere REMOVAL from that array is silently undone the next time the viewer
 * installs or subscribes to the app. Nothing on screen would suggest it: the revoke
 * reported success, the row was written, and the permission came back.
 *
 * ## 🔴 THIS IS A SEAM TEST, AND THE SEAM IS WHY IT EXISTS AS ITS OWN FILE
 *
 * Both halves are individually covered and both individually pass a mutation sweep:
 * `scope-grant.service.test.ts` pins that `recordScopeGrant` unions, and that
 * `getGrantedScopes` subtracts. Neither builds the COMBINED state — a row whose granted
 * array holds a scope its suppression list also holds — because each is scoped to one
 * function. So this drives the REAL `BlockRegistry.recordInstallConsent` (not a stub: the
 * effective-scope computation, the `consentGatedScopes` filter and the union all run) and
 * then feeds the row Prisma was actually asked to write into the REAL `getGrantedScopes`.
 *
 * The composition is the claim. A test that asserted only "the update payload still holds
 * the revoked scope" would pass on a build where the read had stopped subtracting, and a
 * test that asserted only "getGrantedScopes subtracts" would pass on a build where the
 * install path had started passing `clearRevocations`.
 *
 * ## RED/GREEN
 *
 * These cannot be shown red at `origin/main` in the "same test, older code" sense:
 * `revoked_scopes`, `revokeScopes` and `clearRevocations` do not exist there, so the file
 * fails to IMPORT and vitest reports "no tests" rather than a failure — the reassuring zero
 * that is indistinguishable from a probe wired to nothing. The red demonstration is
 * therefore an ISOLATED MUTATION of the one guard each test names, recorded in the PR
 * description with the catching assertion's own message. The mutations are stated in each
 * test below so a future reader can re-run them.
 */

/**
 * 🔴 THE CANONICAL db MOCK, not a per-file direct mock of the `~/server/db/client` module.
 *
 * ⚠️ AND THE PHRASING ABOVE IS DELIBERATE. `no-direct-shared-module-mock`'s detector is
 * TEXTUAL over the whole file, comments included — so writing the guarded call's literal
 * spelling here, even to say we are NOT doing it, makes the guard fail on this file. A
 * false positive costs one reworded sentence and a false negative costs the invariant, so
 * the over-broad match is the right trade; do not "fix" it by adding an allowlist entry.
 *
 * `no-direct-shared-module-mock.test.ts` enforces this and the sibling suites in this
 * directory are allowlisted as PRE-EXISTING, not as precedent — copying their hand-written
 * client is what that ratchet exists to stop. It also matters for correctness here: a
 * hand-written mock typically aliases `dbRead` and `dbWrite` to ONE object, which lets a
 * `dbWrite` call satisfy a `dbRead` assertion, and this file's whole subject is a
 * read-after-write across the grant ledger.
 */
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * 🔴 TWO HANDLES, BECAUSE THE TWO CLIENTS ARE NOT THE SAME THING HERE — and a hand-written
 * mock that aliased them hid it. `recordScopeGrant` (and therefore
 * `BlockRegistry.recordInstallConsent`) always goes to the PRIMARY: it is a read-modify-write
 * of a consent ledger. `getGrantedScopes` defaults to the REPLICA, because the mint path is a
 * pure read. A fixture that satisfies one from the other cannot see a client mix-up, and on
 * this ledger a mix-up is a real defect class — the budget-meaningfulness check in
 * `grantScopes` had exactly that bug (replica lag silently dropped a just-set budget).
 */
const grant = dbMock.dbWrite.appUserScopeGrant;
const grantRead = dbMock.dbRead.appUserScopeGrant;

const REVOKED = 'ai:write:budgeted';
const KEPT = 'collections:read:private';
/** Exempt, so `consentGatedScopes` strips it before the grant is even written. */
const EXEMPT = 'models:read:self';

/**
 * The app's declaration. `effectiveBlockScopes` intersects `manifest.scopes` with
 * `approvedScopes`, so both must list every scope for it to reach the grant.
 */
const MANIFEST = { scopes: [KEPT, REVOKED, EXEMPT] };
const APPROVED = [KEPT, REVOKED, EXEMPT];

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS but not the hybrid-proxy nodes' declared behaviour, so a
  // previous test's `mockResolvedValue` would otherwise survive into the next one.
  grant.findUnique.mockReset();
  grant.create.mockReset();
  grant.update.mockReset();
  grantRead.findUnique.mockReset();
});

describe('an install after a revoke does not resurrect the revoked scope', () => {
  /**
   * 🔴 THE CENTRAL TEST OF THE PHASE.
   *
   * MUTATION THAT MUST KILL IT: delete the `.filter((s) => !revoked.has(s))` in
   * `getGrantedScopes` (`scope-grant.service.ts`) — i.e. restore `new Set(row.grantedScopes)`.
   * The failing assertion must be the `granted.has(REVOKED)` one below, by its own message,
   * not another guard's error.
   */
  it('the union puts it back in the ARRAY, and the read still does not grant it', async () => {
    // A viewer who granted two gated scopes and has since revoked one of them. This is the
    // exact row `revokeScopes` writes for a partial revoke: the suppression list holds the
    // scope, the grant array no longer does, and `revoked_at` is NULL because something is
    // still granted.
    grant.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [KEPT],
      revokedScopes: [REVOKED],
    });
    grant.update.mockResolvedValue({});

    const { BlockRegistry } = await import('../../block-registry.service');
    await BlockRegistry.recordInstallConsent({
      userId: 1,
      appBlockId: 'apb_x',
      version: '2.0.0',
      manifest: MANIFEST,
      approvedScopes: APPROVED,
    });

    const data = grant.update.mock.calls[0][0].data;

    // ── HALF ONE: the union really did happen. This is not a hypothetical — asserting it
    // is what stops this test passing because the install path was quietly narrowed
    // instead, which would make the composition below vacuous.
    expect(
      new Set(data.grantedScopes),
      'recordInstallConsent no longer unions the revoked scope back into granted_scopes. ' +
        'That may be an improvement, but it makes the read-side subtraction below untested ' +
        'by this file — re-point this test at whatever path now performs the union.'
    ).toEqual(new Set([KEPT, REVOKED]));
    // The exempt scope is filtered out by `consentGatedScopes` before the write, which is
    // why it is absent rather than a bug.
    expect(data.grantedScopes).not.toContain(EXEMPT);

    // ── HALF TWO: the install DID NOT clear the suppression. This is the
    // `clearRevocations` asymmetry — the install path must never pass it.
    expect(
      data,
      'recordInstallConsent wrote to revoked_scopes. An implicit install has no consent ' +
        'prompt, so clearing a suppression there undoes a revoke the user performed ' +
        'deliberately — see recordScopeGrant’s clearRevocations docblock.'
    ).not.toHaveProperty('revokedScopes');

    // ── HALF THREE: and therefore the grant still conveys nothing for that scope. Read
    // back through the REAL `getGrantedScopes` over the row Prisma was actually asked to
    // write, so the two halves are composed rather than asserted side by side.
    // 🔴 THE REPLICA HANDLE — `getGrantedScopes` reads `dbRead` by default, which is the
    // client the real mint path uses. Declaring this on `dbWrite` would leave the read
    // answering the canonical mock's `findUnique` default (null) and the composition below
    // would assert over an empty grant, i.e. pass for the wrong reason.
    grantRead.findUnique.mockResolvedValue({
      grantedScopes: data.grantedScopes,
      revokedAt: data.revokedAt ?? null,
      revokedScopes: [REVOKED],
    });
    const { getGrantedScopes } = await import('../scope-grant.service');
    const granted = await getGrantedScopes({ userId: 1, appBlockId: 'apb_x' });

    expect(
      granted.has(REVOKED),
      `an install resurrected the revoked scope "${REVOKED}": it is in granted_scopes ` +
        `(the union put it back) AND in revoked_scopes, and getGrantedScopes returned it. ` +
        `The subtraction in getGrantedScopes is what makes the union harmless — restore it.`
    ).toBe(false);
    // The other granted scope is untouched: "grants nothing" is not the answer for
    // everything.
    expect(granted.has(KEPT)).toBe(true);
  });

  /**
   * THE POSITIVE HALF, and it is the control that makes the test above attributable. With
   * NO revocation on the row, the identical install grants the identical scope. Without
   * this, an implementation that returned an empty set unconditionally would pass the test
   * above for entirely the wrong reason.
   */
  it('CONTROL: with nothing revoked, the same install DOES grant the scope', async () => {
    grant.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [KEPT],
      revokedScopes: [],
    });
    grant.update.mockResolvedValue({});

    const { BlockRegistry } = await import('../../block-registry.service');
    await BlockRegistry.recordInstallConsent({
      userId: 1,
      appBlockId: 'apb_x',
      version: '2.0.0',
      manifest: MANIFEST,
      approvedScopes: APPROVED,
    });
    const data = grant.update.mock.calls[0][0].data;

    grantRead.findUnique.mockResolvedValue({
      grantedScopes: data.grantedScopes,
      revokedAt: null,
      revokedScopes: [],
    });
    const { getGrantedScopes } = await import('../scope-grant.service');
    const granted = await getGrantedScopes({ userId: 1, appBlockId: 'apb_x' });
    expect(granted).toEqual(new Set([KEPT, REVOKED]));
  });

  /**
   * AND THE REMEDY WORKS: an EXPLICIT prompted re-consent lifts the suppression, so the
   * scope comes back — through the path that shows the user a dialog naming it.
   *
   * MUTATION THAT MUST KILL IT: make `recordScopeGrant` ignore `clearRevocations`.
   */
  it('an EXPLICIT prompted re-consent (clearRevocations) does restore it', async () => {
    grant.findUnique.mockResolvedValue({
      id: 'augr_1',
      grantedScopes: [KEPT],
      revokedScopes: [REVOKED],
    });
    grant.update.mockResolvedValue({});

    const { recordScopeGrant, getGrantedScopes } = await import('../scope-grant.service');
    const res = await recordScopeGrant({
      userId: 1,
      appBlockId: 'apb_x',
      version: '2.0.0',
      scopes: [REVOKED],
      clearRevocations: true,
    });
    const data = grant.update.mock.calls[0][0].data;
    expect(data.revokedScopes).toEqual([]);
    expect(res.revokedScopesAfterClear).toEqual([]);

    grantRead.findUnique.mockResolvedValue({
      grantedScopes: data.grantedScopes,
      revokedAt: null,
      revokedScopes: data.revokedScopes,
    });
    const granted = await getGrantedScopes({ userId: 1, appBlockId: 'apb_x' });
    expect(granted.has(REVOKED)).toBe(true);
  });
});

/**
 * 🔴 THE STRUCTURAL LEDGER — PINS THE RELATIONSHIP, NOT ONE SIDE.
 *
 * The behavioural tests above prove the composition holds for the writers that exist
 * TODAY. What they cannot express is closure: a FOURTH writer of `granted_scopes` added
 * next month, in any module, would be outside every fixture here and would reintroduce the
 * resurrection hazard with a green suite. That is the seam-guard shape — an asserted ledger
 * that fails when the set GROWS *or* SHRINKS.
 *
 * ## The relationship being pinned
 *
 * Every production site that writes `grantedScopes` must be in this ledger, and each
 * ledger entry states whether that site may clear a suppression. A new writer fails the
 * count; a removed one fails it too, because a stale allowlist entry is the direction
 * allowlists routinely get wrong.
 *
 * ## 🔴 WHAT THIS DOES **NOT** CHECK, stated so nobody reads it as wider than it is
 *
 * It is a SOURCE-TEXT ledger over Prisma MUTATIONS of `appUserScopeGrant` whose argument
 * names `grantedScopes`. It does not prove a writer handles revocations correctly — the
 * behavioural tests above and in `scope-grant.service.test.ts` do that — and it cannot see
 * a write performed through `$queryRaw` / `$executeRaw`, a Kysely builder, a dynamically
 * computed property key, or a data object assembled in a different file from the
 * `.update()` call. Widen it when one of those appears rather than assuming this is the
 * population.
 *
 * 🔴 IT IS DELIBERATELY NARROWER THAN "any file that mentions `grantedScopes:`". That
 * looser detector was the first version and it flagged FOUR files that write nothing —
 * `pageBlockHostLogic.ts`, `requestConsentGate.ts`, this feature's own tRPC RESPONSE field
 * in `blocks.router.ts`, and the `ScopeGrantSurface` field in `user-app-surface.service.ts`
 * — all of them DTO properties. A ledger that has to list four non-writers to stay green is
 * one whose failures stop meaning anything.
 *
 * It scans production source only: a fixture is free to spell a grant row any way it likes,
 * and a ledger that fails on someone else's test data is a ledger people delete.
 */
describe('every writer of granted_scopes is accounted for', () => {
  const SRC = path.resolve(__dirname, '../../../..');
  const REPO = path.resolve(SRC, '..');

  /**
   * Production `.ts`/`.tsx` under `src/`, excluding tests. Enumerated with `git ls-files`
   * rather than a hand-rolled walk so the corpus is whatever the repo actually tracks.
   */
  function productionSources(): string[] {
    const out = execFileSync('git', ['ls-files', 'src'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .split('\n')
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !/__tests__|\.test\.tsx?$|[\\/]tests?[\\/]/.test(p));
  }

  /** Comments removed, so a prose mention can never satisfy a check below. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  /**
   * Every `appUserScopeGrant.<mutation>( … )` argument list in a source, extracted by
   * BALANCED PARENS rather than by a line or a lazy regex.
   *
   * 🔴 BALANCED, BECAUSE PRETTIER WRAPS. A Prisma write in this repo is always several
   * lines (`{ where: …, data: { … }, select: … }` at printWidth 100), so a single-line or
   * non-greedy match reads the first `)` it finds — frequently inside `new Set(...)` — and
   * concludes the write does not name the field. That is the class of failure that makes a
   * ledger silently stop seeing its own subject.
   */
  function grantMutationArgs(code: string): string[] {
    const regions: string[] = [];
    const re = /appUserScopeGrant\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const start = i;
      for (; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      regions.push(code.slice(start, i + 1));
    }
    return regions;
  }

  /** True when a source contains a Prisma mutation of the grant table naming the field. */
  function writesGrantedScopes(source: string): boolean {
    const code = stripComments(source);
    return grantMutationArgs(code).some((region) => /\bgrantedScopes\s*:/.test(region));
  }

  /**
   * THE LEDGER. Key = file, value = why it writes `grantedScopes` and whether it may lift a
   * suppression. Adding a writer means adding a line here AND answering that second
   * question — which is the whole point: the question is the thing that gets forgotten.
   */
  const ALLOWED_WRITERS: Record<string, { why: string; mayClearRevocations: boolean }> = {
    'src/server/services/blocks/scope-grant.service.ts': {
      why:
        'THE ledger module. `recordScopeGrant` unions (install / subscribe / re-consent) and ' +
        '`revokeScopes` subtracts. It is also the only place that may name `revokedScopes`, ' +
        'and it honours a clear ONLY for the scopes a prompted consent covered.',
      mayClearRevocations: true,
    },
  };

  it('POSITIVE CONTROL: the scan reads real files and finds the known writer', () => {
    const files = productionSources();
    // Without this, every "no unexpected writer" assertion below could pass vacuously on an
    // empty corpus or a broken path.
    expect(files.length).toBeGreaterThan(1000);
    const ledgerFile = 'src/server/services/blocks/scope-grant.service.ts';
    expect(files).toContain(ledgerFile);
    // And the DETECTOR — not merely the read — finds it. A positive control on the file
    // list alone would not notice a regex that matches nothing.
    expect(writesGrantedScopes(readFileSync(path.resolve(REPO, ledgerFile), 'utf8'))).toBe(true);
  });

  it('NEGATIVE CONTROL: the detector separates writes from reads and from prose', () => {
    // Fires on a real write, across lines, with a nested call in the way.
    expect(
      writesGrantedScopes(`await dbWrite.appUserScopeGrant.update({
        where: { id },
        data: { grantedScopes: Array.from(new Set([...a, ...b])) },
      });`)
    ).toBe(true);
    // Does NOT fire on a select projection…
    expect(
      writesGrantedScopes(`await dbRead.appUserScopeGrant.findUnique({
        select: { grantedScopes: true },
      });`)
    ).toBe(false);
    // …nor on a DTO property, which is what the four false positives all were…
    expect(writesGrantedScopes('return { ok: true, grantedScopes: result.grantedScopes };')).toBe(
      false
    );
    // …nor on a comment that names the field.
    expect(
      writesGrantedScopes(`// dbWrite.appUserScopeGrant.update({ data: { grantedScopes: x } })`)
    ).toBe(false);
  });

  it('has no writer outside the ledger, and no stale ledger entry', () => {
    const found = new Set<string>();
    for (const rel of productionSources()) {
      if (writesGrantedScopes(readFileSync(path.resolve(REPO, rel), 'utf8'))) found.add(rel);
    }

    const expected = new Set(Object.keys(ALLOWED_WRITERS));
    const unexpected = [...found].filter((f) => !expected.has(f)).sort();
    const stale = [...expected].filter((f) => !found.has(f)).sort();

    expect(
      unexpected,
      `${unexpected.join(', ')} writes app_user_scope_grants.granted_scopes and is not in ` +
        `ALLOWED_WRITERS. A grant write is a UNION, so it can resurrect a scope the viewer ` +
        `revoked: confirm the new writer either goes through recordScopeGrant WITHOUT ` +
        `clearRevocations, or has an explicit prompted-consent reason to clear one — then ` +
        `add it here with that reason.`
    ).toEqual([]);

    expect(
      stale,
      `${stale.join(', ')} is listed in ALLOWED_WRITERS but no longer writes granted_scopes. ` +
        `Remove it — a stale entry makes this ledger read as coverage of a file that is not ` +
        `there.`
    ).toEqual([]);
  });

  /**
   * 🔴 THE HALF THE COUNT CANNOT SEE. `clearRevocations` is what makes the whole design
   * hold, so the number of sites that PASS it is pinned separately — and to the one caller
   * whose scope set comes from a consent dialog the user actually saw.
   */
  it('exactly one production site passes clearRevocations, and it is the prompted path', () => {
    const passers: string[] = [];
    for (const rel of productionSources()) {
      const code = stripComments(readFileSync(path.resolve(REPO, rel), 'utf8'));
      // The DECLARATION in the service is not a call site — match an assignment to `true`,
      // which is what a caller writes.
      if (/clearRevocations\s*:\s*true/.test(code)) passers.push(rel);
    }
    expect(
      passers.sort(),
      `clearRevocations is passed by ${passers.join(', ')}. It lifts a suppression the ` +
        `viewer created deliberately, so it is legitimate ONLY from a path that showed them ` +
        `a consent dialog naming those exact scopes. BlockRegistry.recordInstallConsent must ` +
        `never pass it — its set is the app's whole ceiling, with no prompt.`
    ).toEqual(['src/server/routers/blocks.router.ts']);
  });
});
