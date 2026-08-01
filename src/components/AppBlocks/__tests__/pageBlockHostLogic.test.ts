import { describe, it, expect } from 'vitest';
import {
  advanceReviewConsentLatch,
  AUTO_RETRY_BACKOFF_MS,
  buildReviewConsentNotification,
  decideAutoRetry,
  grantedPageScopes,
  INITIAL_REVIEW_CONSENT_LATCH,
  isAuthTerminalStatus,
  isAutoRetryableStatus,
  MAX_AUTO_REMINTS,
  MAX_AUTO_RETRIES,
  MID_SESSION_LOSS_ERROR_CLASS,
  pageFallbackReason,
  shouldEmitMidSessionLossBeacon,
  type MidSessionLossBeaconArgs,
  resolveCheckpointPickerRequest,
  resolveImageUploadRequest,
  resolveResourcePickerRequest,
  resolveReviewConsentNotice,
  resolveUngrantableConsentScopes,
  PAGE_RESOURCE_PICKER_TYPES,
  type PageHostStatus,
} from '../pageBlockHostLogic';

/**
 * W10 PageBlockHost pure logic.
 *
 * #3/#6 — grantedPageScopes: the scopes the host advertises in BLOCK_INIT /
 * TOKEN_REFRESH must be the REAL granted set the JWT carries (declared −
 * missing), NOT the old hardcoded `[]`. A page token carries the viewer-scoped
 * ambient `apps:storage:*` scopes; posting `[]` lied to the block.
 *
 * #4 — pageFallbackReason: a full-page surface in a terminal state must render
 * a BlockFallback message (mapped reason), not a blank viewport.
 */

describe('grantedPageScopes (#3/#6 — BLOCK_INIT carries the JWT scopes, not [])', () => {
  it('returns the declared scopes when nothing is withheld (the real JWT scopes — NOT [])', () => {
    const declared = ['apps:storage:read', 'apps:storage:write'];
    expect(grantedPageScopes(declared, [])).toEqual(declared);
    expect(grantedPageScopes(declared, undefined)).toEqual(declared);
    // The regression we're fixing: this must NOT collapse to the old `[]`.
    expect(grantedPageScopes(declared, [])).not.toEqual([]);
  });

  it('strips the consent-withheld scopes from the granted set', () => {
    const declared = ['apps:storage:read', 'apps:storage:write', 'social:read'];
    expect(grantedPageScopes(declared, ['social:read'])).toEqual([
      'apps:storage:read',
      'apps:storage:write',
    ]);
  });

  it('returns [] only when every declared scope is withheld', () => {
    expect(grantedPageScopes(['social:read'], ['social:read'])).toEqual([]);
  });

  it('is a no-op for a missingScopes entry that was never declared', () => {
    const declared = ['apps:storage:read'];
    expect(grantedPageScopes(declared, ['ai:write:budgeted'])).toEqual(declared);
  });
});

describe('resolveUngrantableConsentScopes (Issue B — un-grantable dev-preview consent → toast)', () => {
  it('returns the un-grantable subset when a requested scope is neither granted NOR missing (clamped at mint)', () => {
    // dev-tunnel preview: the token carries models:read:self; the block asks for
    // a scope the tunnel allowlist withheld → not granted, not addable via consent.
    const out = resolveUngrantableConsentScopes(['apps:storage:read'], ['models:read:self'], []);
    expect(out).toEqual(['apps:storage:read']);
  });

  it('returns EMPTY for the BENIGN already-granted case (block re-requests a held scope) — no toast', () => {
    expect(
      resolveUngrantableConsentScopes(
        ['buzz:read:self'],
        ['buzz:read:self', 'models:read:self'],
        []
      )
    ).toEqual([]);
  });

  it('returns EMPTY when the requested scope is grantable via consent (it is in missingScopes) — modal path owns it', () => {
    expect(
      resolveUngrantableConsentScopes(
        ['ai:write:budgeted'],
        ['models:read:self'],
        ['ai:write:budgeted']
      )
    ).toEqual([]);
  });

  it('returns EMPTY when the block sends no hint / a garbage hint (never a fragile heuristic)', () => {
    expect(resolveUngrantableConsentScopes(undefined, ['models:read:self'], [])).toEqual([]);
    expect(resolveUngrantableConsentScopes([], ['models:read:self'], [])).toEqual([]);
    expect(resolveUngrantableConsentScopes('nope', ['models:read:self'], [])).toEqual([]);
    expect(resolveUngrantableConsentScopes([1, null, ''], ['models:read:self'], [])).toEqual([]);
  });

  it('reports ONLY the un-grantable scopes from a mixed hint (drops granted + missing), sorted+deduped', () => {
    const out = resolveUngrantableConsentScopes(
      [
        'apps:storage:write',
        'apps:storage:read',
        'apps:storage:write',
        'buzz:read:self',
        'ai:write:budgeted',
      ],
      ['buzz:read:self'], // already granted
      ['ai:write:budgeted'] // grantable via consent
    );
    expect(out).toEqual(['apps:storage:read', 'apps:storage:write']);
  });

  it('tolerates an undefined missingScopes', () => {
    expect(
      resolveUngrantableConsentScopes(['apps:storage:read'], ['models:read:self'], undefined)
    ).toEqual(['apps:storage:read']);
  });
});

describe('resolveReviewConsentNotice (mod review — silent REQUEST_CONSENT → visible notice)', () => {
  const granted = ['models:read:self', 'user:read:self', 'collections:read:self'];

  it('notifies and NAMES the un-granted scopes the review mint stripped', () => {
    expect(resolveReviewConsentNotice(['buzz:read:self'], granted)).toEqual({
      notify: true,
      scopes: ['buzz:read:self'],
    });
  });

  it('notifies with NO hint at all — the regression: the fire-and-forget SDK call sends none', () => {
    // Unlike the prod path (which stays silent because it cannot tell "already
    // granted" from "clamped"), review has nothing to tell apart: consent can
    // never be granted here, so a hint-less request is still a dead end.
    expect(resolveReviewConsentNotice(undefined, granted)).toEqual({ notify: true, scopes: [] });
    expect(resolveReviewConsentNotice([], granted)).toEqual({ notify: true, scopes: [] });
    expect(resolveReviewConsentNotice('nope', granted)).toEqual({ notify: true, scopes: [] });
    expect(resolveReviewConsentNotice([1, null, ''], granted)).toEqual({
      notify: true,
      scopes: [],
    });
  });

  it('stays SILENT for the benign already-granted re-request (nothing is actually blocked)', () => {
    expect(resolveReviewConsentNotice(['models:read:self'], granted)).toEqual({
      notify: false,
      scopes: [],
    });
    expect(resolveReviewConsentNotice(['models:read:self', 'user:read:self'], granted)).toEqual({
      notify: false,
      scopes: [],
    });
  });

  it('🔴 drops UNKNOWN scope strings from the mod-facing set (untrusted manifest text)', () => {
    // The hint comes from the reviewed app's own frame. Only the fixed platform
    // vocabulary may ever reach a string rendered at the moderator.
    const out = resolveReviewConsentNotice(
      ['<img src=x onerror=alert(1)>', 'totally:made:up', 'buzz:read:self'],
      granted
    );
    expect(out.notify).toBe(true);
    expect(out.scopes).toEqual(['buzz:read:self']);
  });

  it('still notifies (generically) when EVERY un-granted scope is unknown', () => {
    const out = resolveReviewConsentNotice(['totally:made:up'], granted);
    expect(out).toEqual({ notify: true, scopes: [] });
  });

  it('dedupes + sorts the named scopes and ignores the ones already granted', () => {
    const out = resolveReviewConsentNotice(
      ['social:tip:self', 'buzz:read:self', 'social:tip:self', 'models:read:self'],
      granted
    );
    expect(out.scopes).toEqual(['buzz:read:self', 'social:tip:self']);
  });

  it('🔴 drops inherited Object.prototype keys (isKnownBlockScope prototype-chain bypass)', () => {
    // `payload.scopes` is untrusted runtime input from the reviewed app's frame
    // and reaches NO regex shape-check on this path (unlike the manifest
    // validator's SCOPE_RE). While `isKnownBlockScope` used `in`, every inherited
    // Object.prototype key answered "known scope" and would have been printed
    // verbatim into the moderator-facing toast.
    expect(resolveReviewConsentNotice(['constructor', '__proto__'], granted).scopes).toEqual([]);
    expect(
      resolveReviewConsentNotice(
        ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'buzz:read:self'],
        granted
      ).scopes
    ).toEqual(['buzz:read:self']);
    // Still a real, un-grantable request — the mod gets the GENERIC copy, not silence.
    expect(resolveReviewConsentNotice(['constructor'], granted)).toEqual({
      notify: true,
      scopes: [],
    });
  });
});

describe('advanceReviewConsentLatch (🔴 anti-spam bound + the generic→named upgrade)', () => {
  it('shows the first notice of either kind', () => {
    expect(advanceReviewConsentLatch(INITIAL_REVIEW_CONSENT_LATCH, false)).toEqual({
      show: true,
      next: { shown: true, named: false },
    });
    expect(advanceReviewConsentLatch(INITIAL_REVIEW_CONSENT_LATCH, true)).toEqual({
      show: true,
      next: { shown: true, named: true },
    });
  });

  it('allows exactly ONE upgrade generic → named (the first-notice-wins bug)', () => {
    // The SDK's `scopes` hint is OPTIONAL, so a hint-less request on load is an
    // ordinary path. Under a plain boolean latch it won the latch and the app's
    // later, specific request was suppressed for the rest of the mount — the mod
    // never learned WHICH permission was blocked.
    const afterGeneric = advanceReviewConsentLatch(INITIAL_REVIEW_CONSENT_LATCH, false).next;
    const upgrade = advanceReviewConsentLatch(afterGeneric, true);
    expect(upgrade.show).toBe(true);
    expect(upgrade.next).toEqual({ shown: true, named: true });
  });

  it('suppresses a repeat GENERIC after a generic (it adds nothing)', () => {
    const afterGeneric = advanceReviewConsentLatch(INITIAL_REVIEW_CONSENT_LATCH, false).next;
    expect(advanceReviewConsentLatch(afterGeneric, false)).toEqual({
      show: false,
      next: afterGeneric,
    });
  });

  it('suppresses EVERYTHING once a named notice has been shown (no downgrade, no repeat)', () => {
    const afterNamed = advanceReviewConsentLatch(INITIAL_REVIEW_CONSENT_LATCH, true).next;
    expect(advanceReviewConsentLatch(afterNamed, true).show).toBe(false);
    expect(advanceReviewConsentLatch(afterNamed, false).show).toBe(false);
  });

  it('🔴 BOUND: a hostile flood of ANY mix of requests emits at most TWO notices', () => {
    // This is the security property the latch exists for — an untrusted app can
    // post REQUEST_CONSENT in a loop. Exercise every ordering of a long flood.
    const floods: boolean[][] = [
      Array.from({ length: 200 }, () => true),
      Array.from({ length: 200 }, () => false),
      Array.from({ length: 200 }, (_, i) => i % 2 === 0),
      Array.from({ length: 200 }, (_, i) => i % 2 === 1),
      Array.from({ length: 200 }, () => Math.random() < 0.5),
    ];
    for (const flood of floods) {
      let latch = INITIAL_REVIEW_CONSENT_LATCH;
      let shows = 0;
      for (const isNamed of flood) {
        const r = advanceReviewConsentLatch(latch, isNamed);
        latch = r.next;
        if (r.show) shows++;
      }
      expect(shows).toBeLessThanOrEqual(2);
      expect(shows).toBeGreaterThanOrEqual(1);
    }
  });

  it('never mutates the latch it is given', () => {
    const latch = { shown: false, named: false };
    advanceReviewConsentLatch(latch, true);
    expect(latch).toEqual({ shown: false, named: false });
    expect(INITIAL_REVIEW_CONSENT_LATCH).toEqual({ shown: false, named: false });
  });
});

describe('buildReviewConsentNotification (🔴 mode-specific ids + honest Run-for-real copy)', () => {
  const build = (runForReal: boolean, scopes: string[] = []) =>
    buildReviewConsentNotification({ appBlockId: 'pubreq_X', runForReal, scopes });

  it('🔴 render-only and run-for-real produce DISTINCT ids', () => {
    // Mantine no-ops showNotification for an id already displayed/queued (default
    // autoClose 4000ms). A single shared id meant: notice fires in render-only →
    // mod clicks "Run for real…" → host remounts → latch resets by design → the
    // app re-requests within 4s → the run-for-real notice is SILENTLY SWALLOWED,
    // re-creating the original silent-drop bug in the other mode.
    expect(build(false).id).not.toBe(build(true).id);
    expect(build(false, ['buzz:read:self']).id).not.toBe(build(true, ['buzz:read:self']).id);
    expect(build(false).id).toBe('review-consent-pubreq_X-render');
    expect(build(true).id).toBe('review-consent-pubreq_X-real');
  });

  it('🔴 the generic and the named upgrade use DISTINCT ids, and the upgrade supersedes the generic', () => {
    // Same dedupe trap in the other direction: reusing the generic id would make
    // the upgrade a no-op while the generic is still displayed, and
    // updateNotification would drop it once the generic had auto-closed.
    for (const runForReal of [false, true]) {
      const generic = build(runForReal);
      const named = build(runForReal, ['buzz:read:self']);
      expect(named.id).not.toBe(generic.id);
      expect(generic.supersedesId).toBeNull();
      expect(named.supersedesId).toBe(generic.id);
    }
  });

  it('names the scopes when it has them, and falls back to generic copy when it does not', () => {
    expect(build(false, ['buzz:read:self', 'social:tip:self']).message).toContain(
      'buzz:read:self, social:tip:self'
    );
    expect(build(false).message).toContain('doesn’t have here');
  });

  it('🔴 render-only copy states that "Run for real…" spends the MODERATOR\'S OWN Buzz', () => {
    // Untrusted code can emit this toast unprompted right after BLOCK_READY, and
    // it is the one surface pointing a reviewer at the opt-in. The opt-in grants
    // `ai:write:budgeted` against the mod's OWN account under a session Buzz cap,
    // so the copy must not read as a free "make it work" button.
    const message = build(false, ['buzz:read:self']).message;
    expect(message).toContain('Run for real');
    expect(message).toContain('your own account and Buzz');
  });

  it('run-for-real copy does NOT point at the opt-in the mod already took', () => {
    const message = build(true, ['buzz:read:self']).message;
    expect(message).not.toContain('Run for real');
    expect(message).not.toContain('your own account and Buzz');
  });

  it('keeps a stable, non-empty title in every variant', () => {
    for (const runForReal of [false, true]) {
      for (const scopes of [[], ['buzz:read:self']]) {
        expect(build(runForReal, scopes).title).toBe('Permission unavailable in review');
      }
    }
  });
});

describe('pageFallbackReason (#4 — terminal state renders a fallback, not a blank page)', () => {
  it('returns null for the non-terminal states (iframe is rendered, not a fallback)', () => {
    expect(pageFallbackReason('loading')).toBeNull();
    expect(pageFallbackReason('ready')).toBeNull();
  });

  it('maps each terminal state to a BlockFallback reason (so a failed page shows a message)', () => {
    const cases: Array<[PageHostStatus, string]> = [
      ['timeout', 'timeout'],
      ['fatal', 'fatal_block_error'],
      ['no_token', 'token_error'],
      ['error', 'token_error'],
    ];
    for (const [status, reason] of cases) {
      expect(pageFallbackReason(status)).toBe(reason);
    }
  });

  it('never returns null for a terminal failure state (no blank-viewport regression)', () => {
    for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
      expect(pageFallbackReason(status)).not.toBeNull();
    }
  });
});

describe('resolveResourcePickerRequest (OPEN_RESOURCE_PICKER — type allowlist + drop rules)', () => {
  it('accepts a Checkpoint request and returns the canonical type', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r1', resourceType: 'Checkpoint' })).toEqual({
      requestId: 'r1',
      resourceType: 'Checkpoint',
    });
  });

  it('accepts a LoRA request (canonical LORA token)', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r2', resourceType: 'LORA' })).toEqual({
      requestId: 'r2',
      resourceType: 'LORA',
    });
  });

  it('is case-insensitive on the wire but returns the canonical token', () => {
    expect(
      resolveResourcePickerRequest({ requestId: 'r3', resourceType: 'lora' })?.resourceType
    ).toBe('LORA');
    expect(
      resolveResourcePickerRequest({ requestId: 'r4', resourceType: 'checkpoint' })?.resourceType
    ).toBe('Checkpoint');
    expect(
      resolveResourcePickerRequest({ requestId: 'r5', resourceType: '  LoRA  ' })?.resourceType
    ).toBe('LORA');
  });

  it('passes through an optional baseModelGroup family hint', () => {
    expect(
      resolveResourcePickerRequest({
        requestId: 'r6',
        resourceType: 'LORA',
        baseModelGroup: 'Flux1',
      })
    ).toEqual({ requestId: 'r6', resourceType: 'LORA', baseModelGroup: 'Flux1' });
  });

  it('omits an empty/blank baseModelGroup (no spurious family key)', () => {
    const r = resolveResourcePickerRequest({
      requestId: 'r7',
      resourceType: 'Checkpoint',
      baseModelGroup: '',
    });
    expect(r).toEqual({ requestId: 'r7', resourceType: 'Checkpoint' });
    expect(r).not.toHaveProperty('baseModelGroup');
  });

  it('REJECTS an unsupported type (VAE / embeddings / wildcards) → null (modal never opens)', () => {
    for (const t of [
      'VAE',
      'TextualInversion',
      'Wildcards',
      'Upscaler',
      'LoCon',
      'DoRA',
      'Hypernetwork',
    ]) {
      expect(resolveResourcePickerRequest({ requestId: 'r', resourceType: t })).toBeNull();
    }
  });

  it('DROPS a request with a missing or non-string requestId', () => {
    expect(resolveResourcePickerRequest({ resourceType: 'Checkpoint' })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: '', resourceType: 'Checkpoint' })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: 42, resourceType: 'Checkpoint' })).toBeNull();
  });

  it('DROPS a request with a missing or non-string resourceType', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r' })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: 'r', resourceType: 123 })).toBeNull();
    expect(resolveResourcePickerRequest({ requestId: 'r', resourceType: null })).toBeNull();
  });

  it('DROPS non-object / nullish payloads', () => {
    expect(resolveResourcePickerRequest(undefined)).toBeNull();
    expect(resolveResourcePickerRequest(null)).toBeNull();
    expect(resolveResourcePickerRequest('Checkpoint')).toBeNull();
    expect(resolveResourcePickerRequest(123)).toBeNull();
  });

  it('the v1 allowlist is exactly Checkpoint + LoRA (guards against scope creep)', () => {
    expect([...PAGE_RESOURCE_PICKER_TYPES].sort()).toEqual(['Checkpoint', 'LORA']);
  });
});

describe('resolveCheckpointPickerRequest (OPEN_CHECKPOINT_PICKER — dev:live↔prod parity)', () => {
  it('accepts a bare requestId (type is implicitly Checkpoint — no allowlist)', () => {
    expect(resolveCheckpointPickerRequest({ requestId: 'c1' })).toEqual({ requestId: 'c1' });
  });

  it('passes through an optional baseModelGroup family hint', () => {
    expect(resolveCheckpointPickerRequest({ requestId: 'c2', baseModelGroup: 'Flux1' })).toEqual({
      requestId: 'c2',
      baseModelGroup: 'Flux1',
    });
  });

  it('omits an empty/blank baseModelGroup (no spurious family key)', () => {
    const r = resolveCheckpointPickerRequest({ requestId: 'c3', baseModelGroup: '' });
    expect(r).toEqual({ requestId: 'c3' });
    expect(r).not.toHaveProperty('baseModelGroup');
  });

  it('DROPS a request with a missing or non-string requestId', () => {
    expect(resolveCheckpointPickerRequest({})).toBeNull();
    expect(resolveCheckpointPickerRequest({ requestId: '' })).toBeNull();
    expect(resolveCheckpointPickerRequest({ requestId: 42 })).toBeNull();
    expect(resolveCheckpointPickerRequest({ requestId: null })).toBeNull();
  });

  it('DROPS non-object / nullish payloads', () => {
    expect(resolveCheckpointPickerRequest(undefined)).toBeNull();
    expect(resolveCheckpointPickerRequest(null)).toBeNull();
    expect(resolveCheckpointPickerRequest('Checkpoint')).toBeNull();
    expect(resolveCheckpointPickerRequest(123)).toBeNull();
  });
});

describe('resolveImageUploadRequest (OPEN_IMAGE_UPLOAD — requestId drop rule + purpose)', () => {
  it('accepts a valid string requestId and defaults purpose to display + asyncScan false', () => {
    expect(resolveImageUploadRequest({ requestId: 'u1' })).toEqual({
      requestId: 'u1',
      purpose: 'display',
      asyncScan: false,
    });
  });

  it('ignores extra fields (only requestId + purpose + asyncScan are threaded — the rest is server-gated)', () => {
    expect(resolveImageUploadRequest({ requestId: 'u2', junk: 'x', imageId: 5 })).toEqual({
      requestId: 'u2',
      purpose: 'display',
      asyncScan: false,
    });
  });

  it('threads purpose:generationSource when the block requests the unscanned source mode', () => {
    expect(resolveImageUploadRequest({ requestId: 'u_src', purpose: 'generationSource' })).toEqual({
      requestId: 'u_src',
      purpose: 'generationSource',
      asyncScan: false,
    });
  });

  it('opts into asyncScan ONLY for a literal asyncScan === true', () => {
    expect(resolveImageUploadRequest({ requestId: 'u_a', asyncScan: true })).toEqual({
      requestId: 'u_a',
      purpose: 'display',
      asyncScan: true,
    });
    // Any non-true value → false (byte-compatible blocking for an old SDK).
    for (const v of [false, undefined, null, 'true', 1, {}]) {
      expect(resolveImageUploadRequest({ requestId: 'u_b', asyncScan: v }).asyncScan).toBe(false);
    }
    // Absent flag → false.
    expect(resolveImageUploadRequest({ requestId: 'u_c' }).asyncScan).toBe(false);
  });

  it('normalizes an absent purpose to display (SDK back-compat — current SDK sends none)', () => {
    expect(resolveImageUploadRequest({ requestId: 'u_def' }).purpose).toBe('display');
  });

  it('normalizes an unknown / non-string purpose to the safe moderated default (display)', () => {
    expect(resolveImageUploadRequest({ requestId: 'u_x', purpose: 'evil' }).purpose).toBe(
      'display'
    );
    expect(resolveImageUploadRequest({ requestId: 'u_y', purpose: 42 }).purpose).toBe('display');
    expect(resolveImageUploadRequest({ requestId: 'u_z', purpose: null }).purpose).toBe('display');
    // Case-sensitive: only the exact literal opts into the unscanned path.
    expect(
      resolveImageUploadRequest({ requestId: 'u_c', purpose: 'GenerationSource' }).purpose
    ).toBe('display');
  });

  it('DROPS a request with a missing / empty / non-string requestId', () => {
    expect(resolveImageUploadRequest({})).toBeNull();
    expect(resolveImageUploadRequest({ requestId: '' })).toBeNull();
    expect(resolveImageUploadRequest({ requestId: 42 })).toBeNull();
    expect(resolveImageUploadRequest({ requestId: null })).toBeNull();
  });

  it('DROPS non-object / nullish payloads', () => {
    expect(resolveImageUploadRequest(undefined)).toBeNull();
    expect(resolveImageUploadRequest(null)).toBeNull();
    expect(resolveImageUploadRequest('u3')).toBeNull();
    expect(resolveImageUploadRequest(123)).toBeNull();
  });
});

/**
 * BOUNDED AUTO-RETRY (launch-failure recovery).
 *
 * These pin the BOUNDS, in the node env, without paying the host's real 10s/15s
 * timer windows. The two hard constraints:
 *   - the automatic loop is BOUNDED (never unbounded against a down host);
 *   - the RE-MINT count is bounded specifically, because `/api/v1/block-tokens`
 *     is rate-limited (60/min) and only auth terminals re-mint.
 * The browser suite (PageBlockHostAutoRetry.browser.test.tsx) drives the same
 * bounds through the REAL host.
 */
describe('decideAutoRetry — the bounded automatic recovery loop', () => {
  const base = { attempts: 0, reminted: 0, canRemint: true };

  // 🔴 `MAX_AUTO_RETRIES = 0` is the documented ROLLBACK for this feature (there
  // is no flag on the path). A kill switch whose own suite goes red is not a kill
  // switch — you would discover that mid-incident, while trying to ship the
  // one-line disable. Tests that can only hold while auto-retry is ENABLED are
  // gated on that, so flipping the constant to 0 leaves THIS file green; the
  // dedicated test below then asserts the feature really is off. With the feature
  // on (today) nothing is skipped, so there is no coverage loss.
  //
  // 🔴 SCOPE OF THAT CLAIM: this file only. `PageBlockHostAutoRetry.browser.test.tsx`
  // deliberately asserts the ENABLED configuration end-to-end and WILL go red at 0.
  // That is a local `pnpm test:component` cost during a rollback, not a CI one —
  // the browser project is excluded from the CI unit job (see lint.yml) — but do
  // not read "the suite stays green" more broadly than the unit file.
  const itWhenEnabled = MAX_AUTO_RETRIES > 0 ? it : it.skip;

  it('is COMPLETELY OFF when rolled back to MAX_AUTO_RETRIES = 0', () => {
    if (MAX_AUTO_RETRIES > 0) {
      // Feature on: assert the rollback would bite, without mutating the constant.
      expect(decideAutoRetry({ ...base, status: 'timeout', attempts: 0 }).kind).toBe('retry');
      expect(decideAutoRetry({ ...base, status: 'timeout', attempts: MAX_AUTO_RETRIES }).kind).toBe(
        'none'
      );
      return;
    }
    for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
      expect(decideAutoRetry({ ...base, status }).kind, `status=${status}`).toBe('none');
    }
  });

  it('never auto-retries a non-terminal status', () => {
    expect(decideAutoRetry({ ...base, status: 'loading' }).kind).toBe('none');
    expect(decideAutoRetry({ ...base, status: 'ready' }).kind).toBe('none');
  });

  itWhenEnabled('schedules a retry from EVERY terminal reason', () => {
    for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
      const d = decideAutoRetry({ ...base, status });
      expect(d.kind, `status=${status}`).toBe('retry');
    }
  });

  it('BOUNDS the loop at MAX_AUTO_RETRIES — attempt N+1 is never scheduled', () => {
    // Walk the whole budget for a non-auth terminal (no re-mint involved).
    for (let attempts = 0; attempts < MAX_AUTO_RETRIES; attempts++) {
      const d = decideAutoRetry({ ...base, attempts, status: 'timeout' });
      expect(d.kind).toBe('retry');
      if (d.kind === 'retry') expect(d.attempt).toBe(attempts + 1);
    }
    // Budget spent → SETTLED. This is the assertion that fails if the cap is
    // removed (an unbounded loop against a down host).
    expect(decideAutoRetry({ ...base, attempts: MAX_AUTO_RETRIES, status: 'timeout' }).kind).toBe(
      'none'
    );
    expect(
      decideAutoRetry({ ...base, attempts: MAX_AUTO_RETRIES + 5, status: 'timeout' }).kind
    ).toBe('none');
  });

  itWhenEnabled('BACKS OFF between attempts (each delay strictly greater than the last)', () => {
    const delays: number[] = [];
    for (let attempts = 0; attempts < MAX_AUTO_RETRIES; attempts++) {
      const d = decideAutoRetry({ ...base, attempts, status: 'timeout' });
      if (d.kind === 'retry') delays.push(d.delayMs);
    }
    expect(delays).toHaveLength(MAX_AUTO_RETRIES);
    expect(delays).toEqual([...AUTO_RETRY_BACKOFF_MS].slice(0, MAX_AUTO_RETRIES));
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    // Every delay is a real, positive pause — a 0ms "backoff" would be a hot loop.
    for (const d of delays) expect(d).toBeGreaterThan(0);
  });

  itWhenEnabled('marks ONLY the auth terminals as re-minting (the rate-limited path)', () => {
    for (const status of ['no_token', 'error'] as PageHostStatus[]) {
      const d = decideAutoRetry({ ...base, status });
      expect(d.kind === 'retry' && d.remint, `status=${status}`).toBe(true);
    }
    for (const status of ['timeout', 'fatal'] as PageHostStatus[]) {
      const d = decideAutoRetry({ ...base, status });
      expect(d.kind === 'retry' && d.remint, `status=${status}`).toBe(false);
    }
  });

  it('keeps the re-mint cap STRICTLY below the attempt cap, so it can actually bind', () => {
    // 🔴 THE DEAD-CAP GUARD. `reminted` is a SUBSET of `attempts` (every
    // re-minting attempt increments both), so `reminted <= attempts` always
    // holds. The total-attempt check runs FIRST — therefore if the two caps were
    // equal, `reminted >= MAX_AUTO_REMINTS` could only ever be true when
    // `attempts >= MAX_AUTO_RETRIES` had already returned 'none', and the
    // re-mint cap would be unreachable dead code: a stated safety limit that
    // provably cannot fire. This test fails the moment that happens again.
    //
    // The `MAX_AUTO_RETRIES === 0` branch exists because that value is the
    // documented ROLLBACK (auto-retry off). A kill switch whose own test suite
    // goes red is not a kill switch — you'd discover that mid-incident. With the
    // feature off there is no re-mint budget to constrain, so the meaningful
    // assertion becomes "nothing auto-retries at all".
    if (MAX_AUTO_RETRIES === 0) {
      for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
        expect(decideAutoRetry({ ...base, status }).kind, `status=${status}`).toBe('none');
      }
      return;
    }
    expect(MAX_AUTO_REMINTS).toBeLessThan(MAX_AUTO_RETRIES);
    expect(MAX_AUTO_REMINTS).toBeGreaterThan(0);
  });

  it('BOUNDS re-mints at MAX_AUTO_REMINTS from a REACHABLE state — the rate-limit guard', () => {
    // Reachable by construction: walk the auth path from a fresh mount and stop
    // at the first refusal, rather than asserting on a hand-made state the
    // runtime can never produce (which is how this cap was previously "tested"
    // while being unreachable).
    let attempts = 0;
    let reminted = 0;
    const remintedAt: number[] = [];
    for (let i = 0; i < 10; i++) {
      const d = decideAutoRetry({ ...base, status: 'error', attempts, reminted });
      if (d.kind === 'none') break;
      expect(d.remint).toBe(true); // the auth path always re-mints
      remintedAt.push(d.attempt);
      attempts += 1;
      reminted += 1;
    }
    // With auto-retry disabled via the rollback (MAX_AUTO_RETRIES = 0) there is
    // nothing to bound; the kill-switch test above covers that configuration.
    if (MAX_AUTO_RETRIES === 0) {
      expect(reminted).toBe(0);
      return;
    }
    // The AUTH path stops at the RE-MINT cap, strictly before the attempt cap.
    expect(reminted).toBe(MAX_AUTO_REMINTS);
    expect(attempts).toBeLessThan(MAX_AUTO_RETRIES);
    expect(remintedAt).toHaveLength(MAX_AUTO_REMINTS);
    // And the refusal is genuinely the re-mint cap, not the attempt cap: the
    // SAME budget on a non-auth terminal still has attempts left.
    expect(decideAutoRetry({ ...base, status: 'error', attempts, reminted }).kind).toBe('none');
    expect(decideAutoRetry({ ...base, status: 'timeout', attempts, reminted }).kind).toBe('retry');
  });

  itWhenEnabled('advertises the REACHABLE ceiling, not the raw attempt cap', () => {
    // 🔴 The denominator the user is shown ("attempt 1 of N") must be the ceiling
    // actually reachable from the current status. A fresh AUTH failure is bounded
    // by the lower re-mint budget, so promising MAX_AUTO_RETRIES would advertise a
    // retry that can never happen.
    const freshAuth = decideAutoRetry({ ...base, status: 'error' });
    expect(freshAuth.kind).toBe('retry');
    if (freshAuth.kind === 'retry') {
      expect(freshAuth.maxAttempts).toBe(MAX_AUTO_REMINTS);
      // …and that ceiling is genuinely honoured: the sequence really does end there.
      expect(decideAutoRetry({ ...base, status: 'error', attempts: 1, reminted: 1 }).kind).toBe(
        'none'
      );
    }

    // A NON-auth terminal gets the full attempt budget.
    const freshTimeout = decideAutoRetry({ ...base, status: 'timeout' });
    expect(freshTimeout.kind === 'retry' && freshTimeout.maxAttempts).toBe(MAX_AUTO_RETRIES);

    // A MIXED sequence stays honest: a timeout already spent an attempt but no
    // re-mint, so a following auth failure can still reach the attempt cap.
    const mixed = decideAutoRetry({ ...base, status: 'error', attempts: 1, reminted: 0 });
    expect(mixed.kind === 'retry' && mixed.maxAttempts).toBe(MAX_AUTO_RETRIES);

    // The advertised ceiling is never a promise the caps can't keep.
    for (const status of ['timeout', 'fatal', 'no_token', 'error'] as PageHostStatus[]) {
      const d = decideAutoRetry({ ...base, status });
      if (d.kind === 'retry') {
        expect(d.maxAttempts, `status=${status}`).toBeLessThanOrEqual(MAX_AUTO_RETRIES);
        expect(d.maxAttempts, `status=${status}`).toBeGreaterThanOrEqual(d.attempt);
      }
    }
  });

  it('gives NON-auth terminals the full attempt budget (the re-mint cap does not bind them)', () => {
    let attempts = 0;
    for (let i = 0; i < 10; i++) {
      const d = decideAutoRetry({ ...base, status: 'timeout', attempts, reminted: 0 });
      if (d.kind === 'none') break;
      expect(d.remint).toBe(false);
      attempts += 1;
    }
    expect(attempts).toBe(MAX_AUTO_RETRIES);
  });

  itWhenEnabled('does not auto-retry an auth terminal when no re-mint is wired', () => {
    // `canRemint:false` (no onRetryToken) → a remount is a guaranteed re-fail.
    expect(decideAutoRetry({ ...base, canRemint: false, status: 'error' }).kind).toBe('none');
    expect(decideAutoRetry({ ...base, canRemint: false, status: 'no_token' }).kind).toBe('none');
    // Non-auth terminals still retry — they never needed a re-mint.
    expect(decideAutoRetry({ ...base, canRemint: false, status: 'timeout' }).kind).toBe('retry');
    expect(decideAutoRetry({ ...base, canRemint: false, status: 'fatal' }).kind).toBe('retry');
  });

  it('classifies terminals consistently (auto-retryable / auth) ', () => {
    expect(isAutoRetryableStatus('loading')).toBe(false);
    expect(isAutoRetryableStatus('ready')).toBe(false);
    expect(isAutoRetryableStatus('timeout')).toBe(true);
    expect(isAutoRetryableStatus('fatal')).toBe(true);
    expect(isAutoRetryableStatus('no_token')).toBe(true);
    expect(isAutoRetryableStatus('error')).toBe(true);

    expect(isAuthTerminalStatus('error')).toBe(true);
    expect(isAuthTerminalStatus('no_token')).toBe(true);
    expect(isAuthTerminalStatus('timeout')).toBe(false);
    expect(isAuthTerminalStatus('fatal')).toBe(false);
  });

  it('the backoff table covers the whole attempt budget', () => {
    // A shorter table would silently reuse the last delay; assert they line up so
    // a future bump of MAX_AUTO_RETRIES has to extend the table deliberately.
    expect(AUTO_RETRY_BACKOFF_MS.length).toBeGreaterThanOrEqual(MAX_AUTO_RETRIES);
  });
});

/**
 * MID-SESSION credential-loss beacon.
 *
 * 🔴 THE MEASURED DEFECT (production, 2026-07-31): a real revocation teardown was
 * driven against a live app and the platform recorded ZERO error beacons. The
 * host's single emit-once ref had already been spent on the `ok` impression when
 * it reached `ready`, so the launch-failure beacon was inert by construction and
 * the incident's only trace was a record saying the app rendered fine.
 *
 * These cases pin the four conditions that make the replacement signal both
 * REACHABLE (a real teardown emits) and HONEST (nothing else does).
 */
describe('shouldEmitMidSessionLossBeacon', () => {
  /** A host that launched, then had its credential settle as permanently gone. */
  const teardown: MidSessionLossBeaconArgs = {
    status: 'error',
    reachedReady: true,
    tokenTerminal: true,
    hasToken: false,
    alreadyEmitted: false,
  };

  it('🔴 EMITS on the real mid-session teardown (the case that recorded nothing)', () => {
    expect(shouldEmitMidSessionLossBeacon(teardown)).toBe(true);
  });

  it('🔴 does NOT emit for a LAUNCH failure — that is the existing beacon’s job', () => {
    // `loading → error` (mint hard-failed before the block ever rendered). The
    // launch-failure beacon covers it with errorClass 'error'; emitting here too
    // would double-count one failed page load as two failures.
    expect(shouldEmitMidSessionLossBeacon({ ...teardown, reachedReady: false })).toBe(false);
  });

  it('🔴 does NOT emit while recovery is still pending (transient blip)', () => {
    // The upstream hook retries a failed refresh on a bounded backoff. Reporting
    // a teardown that the platform then recovers from would inflate the failure
    // signal with events no user ever saw.
    expect(shouldEmitMidSessionLossBeacon({ ...teardown, tokenTerminal: false })).toBe(false);
  });

  it('🔴 does NOT emit while a usable token remains', () => {
    // `terminal` with a token still in hand is not a teardown — the host is not
    // torn down either (the effect gates on `!token` identically).
    expect(shouldEmitMidSessionLossBeacon({ ...teardown, hasToken: true })).toBe(false);
  });

  it('🔴 is at-most-once per mount', () => {
    // The effect re-runs on token/status/prop churn; without this latch each
    // re-render would fire another beacon for one incident.
    expect(shouldEmitMidSessionLossBeacon({ ...teardown, alreadyEmitted: true })).toBe(false);
  });

  it('does NOT re-tag a BLOCK failure as a credential loss', () => {
    // A block that reached ready and then crashed / stopped acking is a different
    // failure with its own class. Only the `error` status is a credential loss.
    for (const status of ['fatal', 'timeout', 'no_token', 'ready', 'loading'] as PageHostStatus[]) {
      expect(shouldEmitMidSessionLossBeacon({ ...teardown, status })).toBe(false);
    }
  });

  it('requires EVERY condition — no single one is sufficient', () => {
    // Guards against a future simplification that collapses the conjunction.
    const off: MidSessionLossBeaconArgs = {
      status: 'loading',
      reachedReady: false,
      tokenTerminal: false,
      hasToken: true,
      alreadyEmitted: true,
    };
    expect(shouldEmitMidSessionLossBeacon(off)).toBe(false);
    expect(shouldEmitMidSessionLossBeacon({ ...off, status: 'error' })).toBe(false);
    expect(shouldEmitMidSessionLossBeacon({ ...off, reachedReady: true })).toBe(false);
    expect(shouldEmitMidSessionLossBeacon({ ...off, tokenTerminal: true })).toBe(false);
    expect(shouldEmitMidSessionLossBeacon({ ...off, hasToken: false })).toBe(false);
    expect(shouldEmitMidSessionLossBeacon({ ...off, alreadyEmitted: false })).toBe(false);
  });

  it('🔴 uses a class that is DISTINCT from every launch-failure class', () => {
    // If it collided with one of these, the whole point (telling "never launched"
    // apart from "launched, then revoked") would be lost.
    expect(['timeout', 'fatal', 'no_token', 'error', 'error_boundary']).not.toContain(
      MID_SESSION_LOSS_ERROR_CLASS
    );
  });
});

/**
 * 🔴 CROSS-MODULE CONTRACT. The beacon route clamps `errorClass` to a code-owned
 * server-side allowlist; anything outside it collapses to 'other'. A client class
 * that is not on that list is therefore INERT — it reaches the server, is
 * accepted, and then silently merges into the generic bucket, which is exactly
 * the "computed, sent, bounded, then dropped" failure this work exists to fix.
 * This test fails if the two halves ever drift apart.
 */
describe('MID_SESSION_LOSS_ERROR_CLASS survives the server-side allowlist', () => {
  it('is preserved as its own error_class label, not bucketed to "other"', async () => {
    const { normalizeErrorClass } = await import('~/server/metrics/app-block-runtime.metrics');
    expect(normalizeErrorClass('error', MID_SESSION_LOSS_ERROR_CLASS)).toBe(
      MID_SESSION_LOSS_ERROR_CLASS
    );
    // Control: an unknown class really does collapse, so the assertion above is
    // proving membership rather than proving normalizeErrorClass is a no-op.
    expect(normalizeErrorClass('error', 'not_a_real_class')).toBe('other');
  });
});
