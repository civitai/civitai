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
  resolveNavigateRequest,
  resolveResourcePickerRequest,
  resolveReviewConsentNotice,
  toHostGateStatus,
  PAGE_RESOURCE_PICKER_TYPES,
  type PageHostStatus,
} from '../pageBlockHostLogic';
// The production surface→deep-link-base record, imported rather than retyped so a
// new surface (or a changed base) cannot leave the NAVIGATE suite below untested.
import { BLOCK_HOST_DEEP_LINK_BASE } from '../blockInitFragmentGate';

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

  // The picker's allowlist is widened from {Checkpoint, LORA} to the generator's
  // whole LoRA family {LORA, LoCon, DoRA}. This closes a gap that already
  // existed rather than opening a new one: the SPEND-time gate
  // (`PAGE_LORA_MODEL_TYPES` in workflow.service, enforced by
  // `resolvePageLoraGates`) has always accepted LoCon + DoRA, so those two types
  // were already spend-legal while being unpickable — an author could only reach
  // them by hard-coding a version id. Nothing about the spend gate moves here.
  it('accepts a LoCon request (LoRA family) and returns the canonical token', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r8', resourceType: 'LoCon' })).toEqual({
      requestId: 'r8',
      resourceType: 'LoCon',
    });
  });

  it('accepts a DoRA request (LoRA family) and returns the canonical token', () => {
    expect(resolveResourcePickerRequest({ requestId: 'r9', resourceType: 'DoRA' })).toEqual({
      requestId: 'r9',
      resourceType: 'DoRA',
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
    expect(
      resolveResourcePickerRequest({ requestId: 'r5a', resourceType: 'locon' })?.resourceType
    ).toBe('LoCon');
    expect(
      resolveResourcePickerRequest({ requestId: 'r5b', resourceType: '  DORA ' })?.resourceType
    ).toBe('DoRA');
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
    for (const t of ['VAE', 'TextualInversion', 'Wildcards', 'Upscaler', 'Hypernetwork']) {
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

  // Scope-creep guard. UPDATED (not deleted) when the allowlist widened from
  // {Checkpoint, LORA} to Checkpoint + the whole LoRA family. It still asserts an
  // EXACT set, so adding a type this list does not name — VAE, TextualInversion,
  // Wildcards, Upscaler, Hypernetwork, anything — goes red here, in BOTH
  // directions (a growth AND a silent removal).
  it('the allowlist is exactly Checkpoint + the LoRA family (guards against scope creep)', () => {
    expect([...PAGE_RESOURCE_PICKER_TYPES].sort()).toEqual(['Checkpoint', 'DoRA', 'LORA', 'LoCon']);
  });

  // The widening must change WHICH TYPES are offered and nothing else. The
  // resolved request is the entire payload the host derives from an untrusted
  // iframe message, and it is what the caller turns into the native modal's
  // filter — so pinning its whole key set is what proves no maturity /
  // browsing-level / sfwOnly knob was smuggled in alongside the new types.
  it('a resolved request carries ONLY {requestId, resourceType, baseModelGroup?} — no maturity knob', () => {
    for (const resourceType of PAGE_RESOURCE_PICKER_TYPES) {
      const bare = resolveResourcePickerRequest({ requestId: 'rk', resourceType });
      expect(Object.keys(bare ?? {}).sort()).toEqual(['requestId', 'resourceType']);

      const hinted = resolveResourcePickerRequest({
        requestId: 'rk',
        resourceType,
        baseModelGroup: 'SDXL',
        // Fields an untrusted block might try to smuggle through. None is read.
        browsingLevel: 28,
        sfwOnly: false,
        nsfw: true,
      });
      expect(Object.keys(hinted ?? {}).sort()).toEqual([
        'baseModelGroup',
        'requestId',
        'resourceType',
      ]);
    }
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

/**
 * `toHostGateStatus` — the ONE copy of the status shim the five status-gated
 * PageBlockHost message handlers share (REQUEST_CONSENT, OPEN_BUZZ_PURCHASE,
 * REQUEST_SIGN_IN, OPEN_IMAGE_UPLOAD, NAVIGATE). It used to be open-coded at every
 * one of them.
 *
 * The property that actually matters is NOT the specific `'error' → 'no_token'`
 * pairing — it is that `'ready'` is the ONLY input that survives as `'ready'`.
 * Every gate is `=== 'ready'`, so any mapping that invented a `'ready'` would
 * open a money/permission gate on a terminal host. That is asserted
 * exhaustively over the whole `PageHostStatus` union below rather than by
 * spot-checking, so a future variant added to the union cannot slip through
 * unmapped.
 */
describe('toHostGateStatus', () => {
  const ALL: PageHostStatus[] = ['loading', 'ready', 'timeout', 'fatal', 'no_token', 'error'];

  it("maps PageBlockHost's extra terminal 'error' onto a non-ready sentinel", () => {
    expect(toHostGateStatus('error')).toBe('no_token');
  });

  it('passes every other variant through unchanged', () => {
    for (const s of ALL.filter((v) => v !== 'error')) {
      expect(toHostGateStatus(s)).toBe(s);
    }
  });

  it("yields 'ready' for 'ready' and for NOTHING else (the gate-opening property)", () => {
    // Positive control first: the mapping can produce 'ready' at all, so the
    // zero below is a measurement and not a function that returns a constant.
    expect(toHostGateStatus('ready')).toBe('ready');
    const openers = ALL.filter((s) => toHostGateStatus(s) === 'ready');
    expect(openers).toEqual(['ready']);
  });
});

/**
 * NAVIGATE resolution (#5209) — `resolveNavigateRequest`.
 *
 * The defect: `/models/500` and `models/500` resolved IDENTICALLY, because the
 * handler ran `rawPath.replace(/^\/+/, '')` before anything could read the leading
 * slash. A block calling the SDK's own documented example got a URL-bar change, no
 * page change, and a URL that 404s on reload. The two spellings now have distinct
 * meanings:
 *
 *   leading `/`    → SITE-ABSOLUTE, non-shallow, unrestricted across page routes
 *   no leading `/` → APP-SCOPED under `<base>/<slug>/…`, shallow (unchanged)
 *
 * There is deliberately NO destination allowlist. The refusals are about reaching
 * another ORIGIN, traversal, and one narrow `/api/*` exclusion.
 *
 * Every expectation is a literal value, never derived from the implementation —
 * the point is to pin the contract the SDK docs promise.
 */
describe('resolveNavigateRequest (#5209 — site-absolute vs app-scoped)', () => {
  const PAGE = { base: '/apps/run', slug: 'model-benchmarking' };

  describe('site-absolute (leading slash): the case that was broken', () => {
    it("resolves the SDK's documented example to the SITE page, not the app sub-path", () => {
      // 🔴 THE REGRESSION. Before the fix this produced
      // `/apps/run/model-benchmarking/models/12345`.
      expect(resolveNavigateRequest({ path: '/models/12345' }, PAGE)).toEqual({
        scope: 'site',
        href: '/models/12345',
        shallow: false,
        target: 'current',
      });
    });

    it("carries the query string through (the issue's exact consumer case)", () => {
      expect(resolveNavigateRequest({ path: '/models/500?modelVersionId=1001' }, PAGE)).toEqual({
        scope: 'site',
        href: '/models/500?modelVersionId=1001',
        shallow: false,
        target: 'current',
      });
    });

    it('carries a hash through', () => {
      expect(resolveNavigateRequest({ path: '/images/9#comments' }, PAGE)?.href).toBe(
        '/images/9#comments'
      );
    });

    it('does NOT use shallow routing — a shallow push at a site route renders nothing', () => {
      // The second way to reproduce #5209's symptom, so it is pinned separately
      // from the href: a correct href pushed shallowly is still a dead feature.
      expect(resolveNavigateRequest({ path: '/generate' }, PAGE)?.shallow).toBe(false);
    });

    it('resolves a bare "/" to the site root', () => {
      expect(resolveNavigateRequest({ path: '/' }, PAGE)).toEqual({
        scope: 'site',
        href: '/',
        shallow: false,
        target: 'current',
      });
    });

    it('tolerates ONE trailing slash rather than dropping the navigation', () => {
      expect(resolveNavigateRequest({ path: '/generate/' }, PAGE)?.href).toBe('/generate');
    });

    it('is not restricted to an allowlist of destinations — that was the decision', () => {
      // A deliberately arbitrary set, including one that is not a civitai feature.
      // None is refused: the posture is "any page route", not "these routes".
      for (const p of [
        '/models/1',
        '/user/alice',
        '/images/2',
        '/generate',
        '/collections/3',
        '/whatever/deep/page',
      ]) {
        expect(resolveNavigateRequest({ path: p }, PAGE)?.scope, p).toBe('site');
      }
    });
  });

  describe('app-scoped (no leading slash): unchanged behaviour', () => {
    it("resolves under the block's own route with shallow routing", () => {
      expect(resolveNavigateRequest({ path: 'detail/500' }, PAGE)).toEqual({
        scope: 'app',
        href: '/apps/run/model-benchmarking/detail/500',
        shallow: true,
        target: 'current',
      });
    });

    it('resolves an EMPTY path to the app root (the pre-existing behaviour)', () => {
      expect(resolveNavigateRequest({ path: '' }, PAGE)).toEqual({
        scope: 'app',
        href: '/apps/run/model-benchmarking',
        shallow: true,
        target: 'current',
      });
    });

    it('keeps the query on an app-scoped sub-path', () => {
      expect(resolveNavigateRequest({ path: 'detail?id=7' }, PAGE)?.href).toBe(
        '/apps/run/model-benchmarking/detail?id=7'
      );
    });

    it('percent-encodes the SLUG (a slug with a slash cannot forge a route segment)', () => {
      expect(
        resolveNavigateRequest({ path: 'a/b' }, { base: '/apps/run', slug: 'a b/c' })?.href
      ).toBe('/apps/run/a%20b%2Fc/a/b');
    });
  });

  describe('refusals: another ORIGIN is never reachable', () => {
    const HOSTILE = [
      'https://evil.example/steal',
      'http://evil.example',
      'HTTPS://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<b>x</b>',
      'mailto:a@b.c',
      'vbscript:x',
      'models\\500',
    ];

    it('refuses every absolute, protocol-relative and scheme-bearing form', () => {
      for (const path of HOSTILE) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses control characters and whitespace a URL parser would strip', () => {
      // A stripped byte means the string the guard judged is not the string the
      // browser resolves — so these are refused rather than normalised.
      for (const path of ['/mod\tels/1', '/models\n/1', ' /models/1', '/models/1 ', '/mo dels']) {
        expect(resolveNavigateRequest({ path }, PAGE), JSON.stringify(path)).toBeNull();
      }
    });

    it('refuses LITERALLY-SPELLED traversal and empty segments in BOTH scopes', () => {
      // 🔴 THE NAME USED TO READ "refuses traversal and empty segments in BOTH
      // scopes", and that overstated its own coverage in the direction that
      // matters: every fixture here spells the dot segment literally, so the test
      // said nothing about `%2e`, which WHATWG URL also counts as a dot segment
      // and which bypassed the guard these fixtures were pinning. A test name is a
      // coverage claim, and an over-wide one is worse than no test because it stops
      // anyone looking. The encoded spellings are pinned in the
      // "RESOLVED form" describe below; this one is the literal half only.
      for (const path of [
        '/../etc',
        '/a/../b',
        'a/../b',
        '../x',
        '/a//b',
        'a//b',
        '/./a',
        'a/./b',
      ]) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses a non-string path, and a non-object payload', () => {
      for (const raw of [
        undefined,
        null,
        'string',
        42,
        [],
        {},
        { path: 1 },
        { path: null },
        { path: ['/a'] },
      ]) {
        expect(resolveNavigateRequest(raw, PAGE), JSON.stringify(raw ?? null)).toBeNull();
      }
    });
  });

  describe('the /api/* exclusion — deliberately narrow, and NOT an allowlist', () => {
    it('refuses a site-absolute /api path', () => {
      // `router.push('/api/auth/logout')` has no page to render, so Next falls back
      // to a HARD navigation — and that handler takes a bare GET with no method gate
      // and no CSRF token, so the viewer's session ends on a block's say-so.
      for (const path of ['/api/auth/logout', '/api', '/api/v1/models', '/api/']) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses it case-insensitively', () => {
      for (const path of ['/API/auth/logout', '/Api/v1/x', '/aPI']) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('does NOT refuse a path that merely STARTS with the letters api', () => {
      // Positive control for the exclusion: it is a SEGMENT match. Without this the
      // "narrow" claim is untested and a prefix match would pass unnoticed.
      expect(resolveNavigateRequest({ path: '/apiary/1' }, PAGE)?.href).toBe('/apiary/1');
      expect(resolveNavigateRequest({ path: '/models/api' }, PAGE)?.href).toBe('/models/api');
    });

    it('does NOT refuse an APP-SCOPED api sub-path — it reaches no site handler', () => {
      expect(resolveNavigateRequest({ path: 'api/thing' }, PAGE)?.href).toBe(
        '/apps/run/model-benchmarking/api/thing'
      );
    });
  });

  /**
   * 🔴 THE RESOLVED FORM IS WHAT THE CONSUMERS SEE — regression coverage for the
   * percent-encoded dot-segment bypass.
   *
   * Every fixture in this describe was measured against `new URL(path,
   * <origin>)` in node before it was written here, and every expectation is the
   * literal value that measurement produced — never a value read back out of the
   * implementation. The resolutions, for the record:
   *
   *   /%2e%2e/api/auth/logout        -> /api/auth/logout
   *   /%2E%2E/api/auth/logout        -> /api/auth/logout
   *   /%2e/api/auth/logout           -> /api/auth/logout
   *   /.%2e/api/auth/logout          -> /api/auth/logout
   *   /%2e./api/auth/logout          -> /api/auth/logout
   *   /models/%2e%2e/api/auth/logout -> /api/auth/logout
   *   /apps/run/model-benchmarking/%2e%2e/x               -> /apps/run/x
   *   /apps/run/model-benchmarking/%2e%2e/%2e%2e/%2e%2e/x -> /x
   *
   * Both consumers get there: `window.open` resolves the string itself with no
   * Next involved, and Next's `parseRelativeUrl` is `new URL`-based and hands the
   * router the normalised pathname, which misses the route manifest and
   * hard-navigates. Neither needs a user gesture.
   */
  describe('the RESOLVED form is what is judged (percent-encoded dot segments)', () => {
    /**
     * The six shapes that reached `/api/auth/logout` — a bare GET with no method
     * gate and no CSRF token that clears the session, device and legacy cookies.
     * RED at 082ca47d9f: each of these returned a NavigateRequest whose href the
     * consumers resolved to the refused route.
     */
    const ENCODED_API = [
      '/%2e%2e/api/auth/logout',
      '/%2E%2E/api/auth/logout',
      '/%2e/api/auth/logout',
      '/.%2e/api/auth/logout',
      '/%2e./api/auth/logout',
      '/models/%2e%2e/api/auth/logout',
    ];

    it('refuses every percent-encoded dot-segment route to /api/auth/logout', () => {
      for (const path of ENCODED_API) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses them in the new_tab target too — window.open resolves with no Next', () => {
      for (const path of ENCODED_API) {
        expect(resolveNavigateRequest({ path, target: 'new_tab' }, PAGE), path).toBeNull();
      }
    });

    it('refuses an APP-SCOPED path that escapes the block base by encoded traversal', () => {
      // One `%2e%2e` leaves the block's own route; three leave the app surface
      // entirely and land at the site root — the containment property this
      // module's docblock asserts, and which the segment-split could not deliver.
      //
      // ⚠️ ATTRIBUTION, measured rather than assumed: the guard that delivers these
      // refusals is the FIXPOINT RULE, not the containment check. A mutation run
      // forcing the containment condition to `false` left this test GREEN (see the
      // note at that line — it is provably unreachable behind the fixpoint rule).
      // So this test is coverage for the fixpoint rule applied to the app scope, and
      // the containment check has no test that exercises it. Stated so a later
      // reader does not delete the fixpoint rule believing this test protects them.
      expect(resolveNavigateRequest({ path: '%2e%2e/x' }, PAGE)).toBeNull();
      expect(resolveNavigateRequest({ path: '%2e%2e/%2e%2e/%2e%2e/x' }, PAGE)).toBeNull();
    });

    it('refuses a SLUG that is itself a dot segment (the base cannot be walked either)', () => {
      // `encodeURIComponent('..')` is `..` — dots are unreserved — so a `..` slug
      // built an appBase of `/apps/run/..` and the pushed href resolved to
      // `/apps/x`, out of the app surface. Resolving base and path TOGETHER is what
      // sees this; validating only the block's half never could.
      expect(resolveNavigateRequest({ path: 'x' }, { base: '/apps/run', slug: '..' })).toBeNull();
    });

    it('refuses percent-encoded path SEPARATORS, which no downstream decode can split', () => {
      // `new URL` does not decode these, so they survive as ONE segment and the
      // first-segment check would judge `api%2fauth%2flogout` rather than `api`.
      for (const path of [
        '/api%2fauth%2flogout',
        '/API%2Fauth',
        '/a%2fb',
        '/a%5cb',
        'x%2f%2e%2e%2f%2e%2e',
      ]) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses a percent-encoded spelling of the api segment itself', () => {
      // `/%61pi/auth/logout` is a resolution FIXPOINT — `new URL` keeps `%61`
      // literal — so the fixpoint rule does not catch it and the first-segment
      // check must decode before comparing.
      for (const path of ['/%61pi/auth/logout', '/%41PI/x', '/%61%70%69/x']) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses a site path with a malformed escape it cannot decode', () => {
      // A segment whose meaning cannot be established is not pushed. `/a%` and
      // `/a%zz` are fixpoints, so only the decode attempt sees them.
      for (const path of ['/%/x', '/%zz/x', '/%e0%a4%a/x']) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('refuses a path resolution would REWRITE rather than preserve', () => {
      // `/a<b` resolves to `/a%3Cb`. Fail-closed: the block gets no navigation
      // rather than a silently different destination, and it can encode the
      // character itself if it means it.
      for (const path of ['/a<b', '/a>b', '/a`b', '/a{b']) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    it('[invariant guard — green at base] DOUBLE-encoding is deliberately allowed', () => {
      // INVARIANT GUARD, not regression coverage: the pre-change code accepted these
      // too, so it was never red. It is here to pin a DECISION, not to prove a fix.
      //
      // 🔴 A DELIBERATE NON-REFUSAL, pinned so a later reader does not "fix" it.
      // Reaching a dot segment from `%252e` needs TWO decodes. `new URL` does
      // zero, so this is a fixpoint whose first segment is the literal string
      // `%252e%252e`; one downstream decode yields `%2e%2e`, still a literal
      // segment, because dot-segment resolution happens in the URL parser BEFORE
      // the request is sent, not after a server decodes it. Refusing `%25`
      // outright would break `/models/500/50%25-off-lora`, a legitimate slug route.
      expect(resolveNavigateRequest({ path: '/%252e%252e/api/auth/logout' }, PAGE)?.href).toBe(
        '/%252e%252e/api/auth/logout'
      );
      expect(resolveNavigateRequest({ path: '/models/500/50%25-off-lora' }, PAGE)?.href).toBe(
        '/models/500/50%25-off-lora'
      );
    });

    it('[invariant guard — green at base] does NOT refuse a segment merely CONTAINING dots', () => {
      // INVARIANT GUARD, not regression coverage — green before the change too. Its
      // job is to stop the fixpoint rule being over-widened into "refuse any dot",
      // which is the cheapest wrong way to make the red tests above pass.
      //
      // Positive control for the fixpoint rule: `..b`, `b..` and `...` are
      // ordinary literal segments, not dot segments, and are measured fixpoints.
      // Without this the rule could be "refuse anything with a dot in it" and pass.
      expect(resolveNavigateRequest({ path: '/a/..b' }, PAGE)?.href).toBe('/a/..b');
      expect(resolveNavigateRequest({ path: '/a/b..' }, PAGE)?.href).toBe('/a/b..');
      expect(resolveNavigateRequest({ path: '/a/...' }, PAGE)?.href).toBe('/a/...');
      expect(resolveNavigateRequest({ path: 'v1.2/detail' }, PAGE)?.href).toBe(
        '/apps/run/model-benchmarking/v1.2/detail'
      );
    });

    it('[invariant guard — green at base] IDEMPOTENCY: a returned href is a fixpoint', () => {
      // INVARIANT GUARD, not regression coverage — GREEN at 082ca47d9f, because the
      // old code rebuilt the href from already-split segments and so happened to
      // emit fixpoints for every input it ACCEPTED. It could not have caught the
      // bypass, which was about the inputs it accepted, not the hrefs it emitted.
      // It is kept because the new code returns a string produced by a PARSER rather
      // than by concatenation, which is the shape that could regress this.
      //
      // 🔴 The property that makes "judge the resolved form" mean anything: what
      // was validated and what is pushed must be ONE string. If a returned href
      // resolved to something else, the guards above would have been applied to a
      // string the consumer never sees.
      const ORIGIN = 'https://page-block-host.invalid';
      const paths = [
        '/models/12345',
        '/models/500?modelVersionId=1001',
        '/images/9#comments',
        '/generate/',
        '/',
        '/a/..b',
        '/%252e%252e/thing',
        '/models/500/50%25-off-lora',
        'detail/500',
        '',
        'detail?id=7',
        'api/thing',
        'v1.2/detail',
      ];
      let checked = 0;
      for (const path of paths) {
        const href = resolveNavigateRequest({ path }, PAGE)?.href;
        expect(href, `expected a request for ${JSON.stringify(path)}`).toBeTypeOf('string');
        const u = new URL(href as string, ORIGIN);
        expect(u.pathname + u.search + u.hash, JSON.stringify(path)).toBe(href);
        expect(u.origin, JSON.stringify(path)).toBe(ORIGIN);
        checked += 1;
      }
      // Positive control on the loop itself: a filter that matched nothing would
      // otherwise report green.
      expect(checked).toBe(paths.length);
    });

    /**
     * INVARIANT GUARD, not regression coverage — GREEN at 082ca47d9f.
     * The pre-change code refused these too (the literal `..` predicate caught the
     * traversal ones, and `startsWith`-style base building kept the rest inside the
     * block route). They are kept because the NEW code reaches the same verdicts by
     * a completely different route — resolved-form containment rather than a
     * segment blocklist — so they pin that the rewrite did not widen the app scope
     * while closing the encoded hole. Do not count them toward the fix's coverage.
     */
    it('[invariant guard — green at base] keeps literal app-scope traversal refused', () => {
      for (const path of ['../x', 'a/../../x', './x', 'a/./b']) {
        expect(resolveNavigateRequest({ path }, PAGE), path).toBeNull();
      }
    });

    /**
     * INVARIANT GUARD, not regression coverage — GREEN at 082ca47d9f.
     * A sibling route whose name merely starts with the base must not read as
     * contained. The old code could not produce this shape at all (it always
     * emitted `<base>/<segments>`), so there was nothing to regress; the new code
     * CAN, because it validates a resolved string, and this pins that the `/`
     * boundary in the containment check is present rather than a bare `startsWith`.
     */
    it('[invariant guard — green at base] a sibling route is not "contained"', () => {
      expect(
        resolveNavigateRequest({ path: 'detail' }, { base: '/apps/run', slug: 'mb' })?.href
      ).toBe('/apps/run/mb/detail');
      // `/apps/run/mb-evil` starts with `/apps/run/mb` but is a different route.
      // 🔴 NOT ASSERTED, and this test cannot assert it: no input produces that
      // shape, because the candidate is built as the literal `<base>/<path>`. A
      // mutation run confirmed it — dropping the `/` from the containment check
      // (mutant M3b) left every test green. So the two expectations below pin the
      // ACCEPTED shapes only; the boundary refinement is unreachable, and the report
      // for this change says so rather than claiming it is covered.
      expect(resolveNavigateRequest({ path: '' }, { base: '/apps/run', slug: 'mb' })?.href).toBe(
        '/apps/run/mb'
      );
    });
  });

  describe('target normalization (the handler read it NOWHERE before #5209)', () => {
    it("reads a literal 'new_tab'", () => {
      expect(resolveNavigateRequest({ path: '/models/1', target: 'new_tab' }, PAGE)?.target).toBe(
        'new_tab'
      );
    });

    it("defaults to 'current' for absent, unknown and non-string targets", () => {
      for (const target of [
        undefined,
        'current',
        'CURRENT',
        'new tab',
        '_blank',
        1,
        null,
        {},
        ['new_tab'],
      ]) {
        expect(
          resolveNavigateRequest({ path: '/models/1', target }, PAGE)?.target,
          JSON.stringify(target ?? null)
        ).toBe('current');
      }
    });

    it('applies to an app-scoped path too', () => {
      expect(resolveNavigateRequest({ path: 'detail', target: 'new_tab' }, PAGE)).toEqual({
        scope: 'app',
        href: '/apps/run/model-benchmarking/detail',
        shallow: true,
        target: 'new_tab',
      });
    });
  });

  describe('the surface base — all five surfaces, read from the real map', () => {
    const ALL_SURFACES = Object.keys(BLOCK_HOST_DEEP_LINK_BASE) as Array<
      keyof typeof BLOCK_HOST_DEEP_LINK_BASE
    >;

    it('covers every member of BlockHostSurface (a surface added untested fails here)', () => {
      expect([...ALL_SURFACES].sort()).toEqual([
        'dev-tunnel',
        'model-slot',
        'page-run',
        'private-run',
        'review-preview',
      ]);
    });

    it('resolves the app-scoped base per surface, and refuses where the base is null', () => {
      const expected: Record<string, string | null> = {
        'model-slot': null,
        'page-run': '/apps/run/demo/sub',
        'dev-tunnel': '/apps/run/demo/sub',
        // 🔴 null since #5209 — the moderator's review preview performs no
        // block-requested navigation, in either scope.
        'review-preview': null,
        'private-run': '/apps/private-run/demo/sub',
      };
      for (const surface of ALL_SURFACES) {
        const got = resolveNavigateRequest(
          { path: 'sub' },
          { base: BLOCK_HOST_DEEP_LINK_BASE[surface], slug: 'demo' }
        );
        expect(got?.href ?? null, `app-scoped on ${surface}`).toBe(expected[surface]);
      }
    });

    it('a null base refuses a SITE-ABSOLUTE path too, not just an app-scoped one', () => {
      // The important half: a surface with no page route of its own must not be a
      // way to move the viewer anywhere on the site.
      const nullBase = ALL_SURFACES.filter((s) => BLOCK_HOST_DEEP_LINK_BASE[s] === null);
      expect(nullBase.length).toBeGreaterThan(0); // the loop below is not vacuous
      for (const surface of nullBase) {
        expect(
          resolveNavigateRequest(
            { path: '/models/500' },
            { base: BLOCK_HOST_DEEP_LINK_BASE[surface], slug: 'demo' }
          ),
          `site-absolute on ${surface}`
        ).toBeNull();
      }
    });

    it('a non-null base DOES allow a site-absolute path (positive control for the above)', () => {
      const withBase = ALL_SURFACES.filter((s) => BLOCK_HOST_DEEP_LINK_BASE[s] !== null);
      expect(withBase.length).toBeGreaterThan(0);
      for (const surface of withBase) {
        expect(
          resolveNavigateRequest(
            { path: '/models/500' },
            { base: BLOCK_HOST_DEEP_LINK_BASE[surface], slug: 'demo' }
          )?.href,
          `site-absolute on ${surface}`
        ).toBe('/models/500');
      }
    });

    it('the site-absolute href depends on NEITHER the base nor the slug', () => {
      // Two fixtures whose base and slug are pairwise distinct AND distinct from
      // every substring of the expected value, so a mutant that leaked either into
      // the site href cannot survive.
      expect(
        resolveNavigateRequest({ path: '/models/500' }, { base: '/apps/run', slug: 'aaa' })?.href
      ).toBe('/models/500');
      expect(
        resolveNavigateRequest({ path: '/models/500' }, { base: '/apps/private-run', slug: 'zzz' })
          ?.href
      ).toBe('/models/500');
    });
  });
});
