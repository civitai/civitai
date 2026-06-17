import { randomBytes } from 'crypto';

// Crockford base32 alphabet (no I, L, O, U)
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LEN = 16;

function encodeTime(time: number, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = time % 32;
    out = ALPHABET[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

// 32-character Crockford base32 alphabet over 8-bit bytes. 256 / 32 = 8
// exactly, so `byte % 32` is uniform without rejection sampling. If
// ALPHABET length ever changes to a value that doesn't divide 256 evenly,
// switch to rejection sampling against the largest multiple of N below 256.
function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const out: number[] = new Array(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) out[i] = bytes[i] % 32;
  return out;
}

function encodeRandom(digits: number[]): string {
  let out = '';
  for (const d of digits) out += ALPHABET[d];
  return out;
}

// Same-millisecond monotonicity: when the time prefix matches the previous
// call, increment the random suffix by 1 instead of regenerating it. This
// matches the `ulid` package's spec.monotonic() behavior — without it, two
// IDs minted in the same millisecond can sort in arbitrary order. Carrying
// across the high bit overflow throws (vanishingly rare with 80-bit space).
let lastTime = -1;
let lastRandom: number[] = freshRandom();

function nextRandom(time: number): number[] {
  if (time !== lastTime) {
    lastTime = time;
    lastRandom = freshRandom();
    return lastRandom;
  }
  // Increment lastRandom in place, base-32, from the least-significant digit up.
  const next = lastRandom.slice();
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i] += 1;
      lastRandom = next;
      return next;
    }
    next[i] = 0;
  }
  // Overflow — extremely unlikely given 80 bits per millisecond. Fail loud
  // so we'd notice rather than silently regress sortability.
  throw new Error('app-block-ids: random suffix overflow within a single millisecond');
}

/**
 * Returns a ULID-format identifier (26-char Crockford base32, 48-bit timestamp + 80-bit randomness).
 * Within a single millisecond IDs are strictly monotonic — newer ids sort
 * later even at sub-ms cadence. Sufficient for our id needs without taking
 * the `ulid` npm dependency.
 */
export function newUlid(): string {
  const time = Date.now();
  return encodeTime(time, 10) + encodeRandom(nextRandom(time));
}

export function newAppBlockId(): string {
  return `ab_${newUlid()}`;
}

export function newModelBlockInstallId(): string {
  return `mbi_${newUlid()}`;
}

export function newBlockInstanceId(): string {
  return `bki_${newUlid()}`;
}

export function newBlockUserSubscriptionId(): string {
  return `bus_${newUlid()}`;
}

export function newBlockBuzzAttributionId(): string {
  return `bba_${newUlid()}`;
}

export function newBlockAttributionPayoutId(): string {
  return `bba_payout_${newUlid()}`;
}

export function newAppUserScopeGrantId(): string {
  return `augr_${newUlid()}`;
}

/**
 * Tracking record for a publisher revenue-share DISBURSEMENT (Tipalti). One per
 * `withdrawAppRevenue` attempt. Kept on its own `block_payout_withdrawal` table
 * so app-revenue payouts are never conflated with creator-program
 * `CashWithdrawal` rows (separate rail).
 */
export function newBlockPayoutWithdrawalId(): string {
  return `bpw_${newUlid()}`;
}

/**
 * App-Blocks-rail Tipalti refCode prefix. Deliberately does NOT start with
 * 'CW' (the creator-program `CashWithdrawal` prefix) so the Tipalti webhook can
 * dispatch app-rail payments to the dedicated `block_payout_withdrawal`
 * reconciliation handler BEFORE the `startsWith('CW')` branch — routing them
 * into the CW handler would 400 (the lookup fails) and leave the row stuck
 * forever. See `tipalti.ts` and `getBlockPayoutRefCode`.
 */
export const BLOCK_PAYOUT_REFCODE_PREFIX = 'BPW';

/**
 * Derive a Tipalti refCode for an App-Blocks payout from its withdrawal id.
 *
 * Tipalti caps refCodes at 16 chars (`payToTipaltiAccount` slices
 * `requestId.slice(0, 16)`), so we CANNOT round-trip the full `bpw_<ulid>` id
 * back out of the refCode. Instead the refCode is `BPW` + the last 13 chars of
 * the ULID suffix (the high-entropy random tail) = exactly 16 chars, and the
 * FULL refCode is persisted on the `block_payout_withdrawal` row + indexed, so
 * the webhook looks the row up by exact `ref_code` match rather than parsing the
 * id back out. Collision risk across the 13-char Crockford tail (65 bits) is
 * negligible, and the unique `ref_code` lookup is exact regardless.
 *
 * @param withdrawalId a `bpw_<ulid>` id from `newBlockPayoutWithdrawalId`
 */
export function getBlockPayoutRefCode(withdrawalId: string): string {
  // Strip the 'bpw_' prefix to get the 26-char ULID, then take its tail so the
  // refCode carries the random (collision-resistant) portion, not just the
  // shared millisecond timestamp prefix.
  const ulid = withdrawalId.startsWith('bpw_') ? withdrawalId.slice(4) : withdrawalId;
  const tail = ulid.slice(-13);
  return `${BLOCK_PAYOUT_REFCODE_PREFIX}${tail}`; // 3 + 13 = 16 chars
}

/** True if a Tipalti refCode belongs to the App-Blocks payout rail. */
export function isBlockPayoutRefCode(refCode: string): boolean {
  return refCode.startsWith(BLOCK_PAYOUT_REFCODE_PREFIX);
}
