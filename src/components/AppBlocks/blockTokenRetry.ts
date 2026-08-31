// Pure decisions for `useBlockToken`'s mid-session refresh-failure recovery.
//
// Extracted from the hook for the same reason `pageBlockHostLogic` was extracted
// from PageBlockHost: civitai-web's `unit` vitest project runs `environment:
// 'node'` and only collects `*.test.ts`, so a decision that lives inside a React
// hook can only ever be exercised through a browser test. The BOUNDS below are
// the security/cost-relevant part (they gate an automatic loop against a
// rate-limited endpoint), so they get cheap, exhaustive, node-env coverage —
// and the hook keeps ONE code path, reading these functions rather than
// re-deriving the rules inline.
//
// ── THE DEFECT THESE EXIST FOR ───────────────────────────────────────────────
// A refresh that FAILED mid-session used to set `error`, null the token, and
// schedule NOTHING. The success path was the only place a timer was ever armed,
// so the sole route back was the user hiding and re-showing the tab
// (`visibilitychange`). Downstream that read as: the model-slot block VANISHING
// mid-session (BlockHost collapses on `error`) and taking in-progress state with
// it, or the page host silently sitting on a dead token while the block 401s.

/**
 * Maximum AUTOMATIC re-mint attempts after a refresh failure, per failure
 * episode (reset on the next success).
 *
 * 🔴 BOUNDED, DELIBERATELY. `/api/v1/block-tokens` is rate-limited to 60/min per
 * (user, instance). An unbounded auth-failure loop is exactly the shape that
 * burns that budget and turns a brief upstream blip into a self-inflicted
 * rate-limit event. After this many attempts the hook SETTLES: `terminal` goes
 * true, consumers show their real terminal state, and recovery is user-driven
 * (the page host's manual Retry, a `visibilitychange`, or an explicit
 * `refresh()`).
 *
 * 🔴 ROLLBACK: setting this to 0 cleanly restores the pre-fix behaviour — every
 * failure settles immediately and no automatic timer is ever armed. There is no
 * feature flag on this path; this constant is the kill switch.
 */
export const MAX_REFRESH_RETRIES = 3;

/**
 * Backoff before automatic attempt N (index 0 = the first retry). Escalating, so
 * a one-off blip clears in seconds while a sustained outage stops hammering.
 *
 * 🔴 The last entry (30s) is deliberately HALF the 60s rate-limit window, so even
 * the worst case — every attempt failing — spends 3 requests across ~40s, an
 * order of magnitude under the 60/min ceiling.
 *
 * Indices past the end reuse the last value (defensive; today the array covers
 * MAX_REFRESH_RETRIES exactly, and a test pins that).
 */
export const REFRESH_RETRY_BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];

/**
 * Mint failures the server will keep refusing. Retrying cannot help — and, the
 * security-relevant half, CONTINUING TO SERVE the held token would extend
 * authorization past a decision the server has already made.
 *
 * 🔴 WHY THIS EXISTS. The mint enforces ban, moderator delist ("Block is not
 * approved"), account-level app access, per-viewer scope narrowing, and the
 * `.red` domain gate — and for most of those the block-scope middleware has NO
 * runtime re-check (only uninstall/disable are re-checked live, via
 * `BlockRevocation`). So the mint's 4xx IS the revocation signal. Before this
 * PR, any mint failure unmounted the block within ~0s, which incidentally
 * destroyed the block's in-memory copy of the JWT. Retention is right for a
 * transient 5xx/network blip and WRONG here: it would keep a signature-valid,
 * unexpired credential live for the rest of its lifetime (~2 min normally, up to
 * the full ~15 min if a `visibilitychange` mint is what failed, and up to 4h for
 * a dev-tunnel token). Status-blind retention would have been an authorization
 * extension introduced by a resilience feature.
 *
 * 409/422 are included as "the server rejected this request on its merits";
 * 429 is deliberately ABSENT (it is explicitly transient and already has its own
 * jittered in-band pause), as is every 5xx.
 */
export const TERMINAL_MINT_STATUSES: readonly number[] = [401, 403, 404, 409, 422];

/** An Error carrying the mint response's HTTP status (absent for network/abort). */
export type MintError = Error & { status?: number };

/** True when the mint's HTTP status means "refused, and will stay refused". */
export function isTerminalMintStatus(status: number | undefined): boolean {
  return status !== undefined && TERMINAL_MINT_STATUSES.includes(status);
}

export type RefreshRetryDecision =
  /** Arm a backoff timer for another automatic attempt. */
  | {
      kind: 'retry';
      /** 1-based index of the attempt being scheduled. */ attempt: number;
      delayMs: number;
    }
  /** Budget spent — no further AUTOMATIC attempt. The hook is now `terminal`. */
  | { kind: 'settled' };

/**
 * Decide whether another automatic re-mint should be scheduled after a failure.
 *
 * Pure so the bound is provable without driving real 2s/8s/30s windows, and so
 * the hook cannot disagree with itself: the same decision drives BOTH the timer
 * that is armed AND the `terminal` flag consumers key their destructive UI on.
 *
 * `attempts` is the number of automatic attempts ALREADY performed in this
 * failure episode (0 on the first failure after a success).
 */
export function decideRefreshRetry(args: {
  attempts: number;
  /** HTTP status of the failed mint, when the failure was an HTTP response. */
  mintStatus?: number;
}): RefreshRetryDecision {
  // 🔴 A terminal refusal settles IMMEDIATELY. Retrying a 403 cannot succeed:
  // it just burns 3 more POSTs against a rate-limited endpoint and delays the
  // honest terminal state by ~40s (on the model slot, 40s of animated skeleton
  // where the documented contract is to collapse instantly).
  if (isTerminalMintStatus(args.mintStatus)) return { kind: 'settled' };
  const attempts = Math.max(0, Math.floor(args.attempts));
  if (attempts >= MAX_REFRESH_RETRIES) return { kind: 'settled' };
  const delayMs =
    REFRESH_RETRY_BACKOFF_MS[attempts] ??
    REFRESH_RETRY_BACKOFF_MS[REFRESH_RETRY_BACKOFF_MS.length - 1];
  return { kind: 'retry', attempt: attempts + 1, delayMs };
}

/**
 * Should a REFRESH failure keep the token we already hold?
 *
 * 🔴 THIS IS THE FIX FOR THE MODEL-SLOT VANISH. A refresh failure means we could
 * not obtain a NEW credential — it says nothing about the one already in hand.
 * Refreshes are scheduled at T-2min, so at failure time the held token normally
 * has ~2 minutes of life left. Nulling it (the old behaviour) unmounted the
 * whole iframe: in-progress user state was destroyed, and the eventual recovery
 * REMOUNTED the host, re-running BLOCK_INIT and emitting a SECOND impression
 * beacon for one logical view. Retaining it keeps the block mounted and working
 * through the entire retry window, so a transient blip is invisible.
 *
 * 🔴 FAIL CLOSED on an unusable expiry. A missing/unparseable `expiresAt` means
 * we cannot prove the token is still live, so we drop it rather than serve a
 * credential of unknown validity — that would be the "silently 401s" failure
 * this change exists to end.
 *
 * NOTE the caller re-evaluates this on EVERY failure, so a token that expires
 * part-way through the retry sequence is dropped at the next attempt. The one
 * case that needs separate handling is a token retained at the moment the budget
 * SETTLES (no further failure will re-evaluate it) — `msUntilExpiry` gives the
 * caller the deadline to sweep it at.
 */
export function shouldRetainTokenOnFailure(args: {
  token: string | null;
  expiresAt: string | null;
  now: number;
  /** HTTP status of the failed mint, when the failure was an HTTP response. */
  mintStatus?: number;
}): boolean {
  const { token, expiresAt, now, mintStatus } = args;
  // 🔴 NEVER retain past a terminal refusal — see TERMINAL_MINT_STATUSES. This is
  // the difference between "the network blipped, keep working" and "you have been
  // banned/delisted, keep working anyway".
  if (isTerminalMintStatus(mintStatus)) return false;
  if (!token || !expiresAt) return false;
  const ms = new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) return false;
  return ms > now;
}

/**
 * Milliseconds until `expiresAt`, floored at 0, or `null` when the expiry is
 * absent/unparseable. Used to arm the one-shot sweep that drops a token retained
 * across a SETTLED failure — without it the host would hold an expired token
 * forever and quietly 401, which is precisely the page-host half of the defect.
 */
export function msUntilExpiry(expiresAt: string | null, now: number): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, ms - now);
}
