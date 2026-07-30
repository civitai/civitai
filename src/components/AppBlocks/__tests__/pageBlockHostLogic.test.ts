import { describe, it, expect } from 'vitest';
import {
  AUTO_RETRY_BACKOFF_MS,
  decideAutoRetry,
  grantedPageScopes,
  isAuthTerminalStatus,
  isAutoRetryableStatus,
  MAX_AUTO_REMINTS,
  MAX_AUTO_RETRIES,
  pageFallbackReason,
  resolveCheckpointPickerRequest,
  resolveImageUploadRequest,
  resolveResourcePickerRequest,
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
