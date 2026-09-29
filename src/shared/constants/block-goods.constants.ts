/**
 * App Blocks DIGITAL GOODS — the manifest-declared catalog contract and the
 * revenue split. Pure constants + pure functions, client-safe: the manifest
 * validator, the purchase endpoint and any future store UI all read them here.
 *
 * A "good" is an entitlement the platform sells on an app's behalf for Buzz.
 * The platform owns the LEDGER (who bought what, when, at what price, and
 * whether it was refunded); the good's MEANING is the app's business — the app
 * reads the viewer's entitlements and keeps the semantics in its own storage.
 * The manifest `payload` is carried verbatim onto the entitlement and is never
 * interpreted here.
 */

/**
 * Share of a good's price the APP OWNER keeps; the platform keeps the
 * remainder. Matches the cosmetic shop's creator share today.
 *
 * 🔴 Deliberately NOT an alias of `CREATOR_SHOP_CREATOR_SHARE`. The two are the
 * same number by policy, not by construction — aliasing would make a creator
 * shop repricing silently reprice every app's goods, in a different product,
 * with no review. They are independent knobs that currently agree.
 */
export const BLOCK_GOOD_APP_OWNER_SHARE = 0.7;

/**
 * THE single source of truth for how a goods sale splits — used by the payout
 * AND by anything that displays the numbers, so what is shown always equals
 * what is paid. Never re-multiply the share at a call site.
 *
 * The app owner's share FLOORS and the platform takes the remainder, so the two
 * parts always sum to `priceBuzz` exactly (the conservation CHECK on
 * `block_good_purchase` enforces that at write time) and rounding never creates
 * Buzz.
 */
export function computeBlockGoodSplit(priceBuzz: number): {
  appOwnerShare: number;
  platformShare: number;
} {
  const appOwnerShare = Math.floor(priceBuzz * BLOCK_GOOD_APP_OWNER_SHARE);
  return { appOwnerShare, platformShare: priceBuzz - appOwnerShare };
}

/**
 * How much of a recipient's share is paid back in BLUE, given how much of the
 * price the buyer paid in blue. Floors, so the blue leg can never exceed the
 * proportional amount; the remainder is paid in the domain colour. Mirrors the
 * cosmetic shop's per-recipient proration.
 */
export function blueLegOfPayout(args: {
  recipientAmount: number;
  bluePaid: number;
  priceBuzz: number;
}): number {
  const { recipientAmount, bluePaid, priceBuzz } = args;
  // INVARIANT GUARD, not coverage: a zero price is unreachable in production —
  // the manifest parser floors it at BLOCK_GOOD_MIN_PRICE_BUZZ and the
  // `price_buzz > 0` CHECK enforces it at the database. It is here so the
  // division cannot produce NaN if this pure helper is ever reused somewhere
  // those two bounds do not apply.
  if (priceBuzz <= 0) return 0;
  return Math.floor((recipientAmount * bluePaid) / priceBuzz);
}

/**
 * Cheapest a good may be listed for. Buzz has no sub-unit, so a price of 1
 * would floor the owner's 70% to ZERO — the app would sell an item and earn
 * nothing from it, permanently and silently. The floor is therefore the
 * smallest price at which the owner's share is at least 1, DERIVED from the
 * share rather than written as a literal so it stays correct if the split ever
 * moves. (Same defect shape the author-fee ledger records for a 0 flat leg.)
 */
export const BLOCK_GOOD_MIN_PRICE_BUZZ = Math.ceil(1 / BLOCK_GOOD_APP_OWNER_SHARE);

/**
 * Hard ceiling on a single good's price, enforced at BOTH manifest validation
 * and purchase time. Re-checking at purchase matters: a manifest approved
 * before a ceiling change would otherwise keep charging the old price forever.
 */
export const BLOCK_GOOD_MAX_PRICE_BUZZ = 50_000;

/** Most goods one manifest may declare. */
export const BLOCK_GOOD_MAX_PER_MANIFEST = 32;

/**
 * `id` charset — lowercase, URL- and log-safe, and colon-free so it can be
 * composed into a redis key and a ledger external id.
 *
 * 🔴 THE LENGTH IS NOT IN THE REGEX. It was (`{0,63}`), which made
 * `BLOCK_GOOD_ID_MAX_LENGTH` ornamental — read only by an error message — so
 * widening the regex passed every test while the published schema, byte-mirrored
 * into the Go CLI and the SDK, still said 64. The bound is checked against the
 * constant instead, so the schema drift guard and the parser cannot disagree.
 */
export const BLOCK_GOOD_ID_MAX_LENGTH = 64;
export const BLOCK_GOOD_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const BLOCK_GOOD_TITLE_MAX_LENGTH = 80;
export const BLOCK_GOOD_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Serialized ceiling on the opaque app payload. The platform never reads it, so
 * the only thing bounding it is storage; 2 KiB is generous for a handful of
 * app-side flags and small enough that a manifest cannot smuggle a bundle.
 */
export const BLOCK_GOOD_PAYLOAD_MAX_BYTES = 2048;

/**
 * What an entitlement GRANTS, from the platform's point of view.
 *
 * - `good` — an ordinary in-app purchase. The platform records it and says
 *   nothing about what it means.
 * - `app_unlock` — a one-time unlock of the app itself. Recorded identically;
 *   the platform does NOT act on it yet. Declaring the value now is what lets
 *   the paid-app gate land later without a migration.
 */
export const BLOCK_GOOD_KINDS = ['good', 'app_unlock'] as const;
export type BlockGoodKind = (typeof BLOCK_GOOD_KINDS)[number];
export const BLOCK_GOOD_DEFAULT_KIND: BlockGoodKind = 'good';

export function isBlockGoodKind(value: unknown): value is BlockGoodKind {
  return typeof value === 'string' && (BLOCK_GOOD_KINDS as readonly string[]).includes(value);
}

/** One entry of a manifest's `goods[]`, after validation. */
export type BlockGoodDeclaration = {
  id: string;
  title: string;
  description?: string;
  priceBuzz: number;
  kind: BlockGoodKind;
  payload: Record<string, unknown>;
};

/** Manifest-shaped input for the goods rules. Only the field they read. */
export type GoodsManifestInput = { goods?: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * THE goods parser. The submit-time manifest validator and the purchase
 * endpoint both call it, so a good that cannot be validated can never be
 * bought and a good that validates is bought on exactly the terms that were
 * reviewed.
 *
 * Total, never throws: returns the declarations it could accept plus a message
 * per rejection. A manifest with NO `goods` key is valid and sells nothing —
 * every app that exists today is in that state.
 */
export function parseManifestGoods(manifest: GoodsManifestInput): {
  goods: BlockGoodDeclaration[];
  errors: string[];
} {
  const raw = manifest.goods;
  if (raw === undefined || raw === null) return { goods: [], errors: [] };
  if (!Array.isArray(raw)) return { goods: [], errors: ['goods must be an array'] };
  if (raw.length > BLOCK_GOOD_MAX_PER_MANIFEST)
    return {
      goods: [],
      errors: [`goods may declare at most ${BLOCK_GOOD_MAX_PER_MANIFEST} entries`],
    };

  const errors: string[] = [];
  const goods: BlockGoodDeclaration[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const at = `goods[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }

    const { id, title, description, priceBuzz, kind, payload } = entry;

    if (
      typeof id !== 'string' ||
      id.length > BLOCK_GOOD_ID_MAX_LENGTH ||
      !BLOCK_GOOD_ID_RE.test(id)
    ) {
      errors.push(
        `${at}.id must be lowercase alphanumeric with - or _, starting with a letter or digit, at most ${BLOCK_GOOD_ID_MAX_LENGTH} characters`
      );
      return;
    }
    // Duplicate ids are fatal for the WHOLE entry rather than "last wins": the
    // purchase path looks a good up by id, and two rows answering to one id
    // means the price charged depends on iteration order.
    if (seen.has(id)) {
      errors.push(`${at}.id duplicates an earlier good id ("${id}")`);
      return;
    }
    seen.add(id);

    if (typeof title !== 'string' || title.trim().length === 0) {
      errors.push(`${at}.title must be a non-empty string`);
      return;
    }
    if (title.trim().length > BLOCK_GOOD_TITLE_MAX_LENGTH) {
      errors.push(`${at}.title must be at most ${BLOCK_GOOD_TITLE_MAX_LENGTH} characters`);
      return;
    }

    if (description !== undefined) {
      if (typeof description !== 'string') {
        errors.push(`${at}.description must be a string`);
        return;
      }
      if (description.trim().length > BLOCK_GOOD_DESCRIPTION_MAX_LENGTH) {
        errors.push(
          `${at}.description must be at most ${BLOCK_GOOD_DESCRIPTION_MAX_LENGTH} characters`
        );
        return;
      }
    }

    if (
      typeof priceBuzz !== 'number' ||
      !Number.isSafeInteger(priceBuzz) ||
      priceBuzz < BLOCK_GOOD_MIN_PRICE_BUZZ ||
      priceBuzz > BLOCK_GOOD_MAX_PRICE_BUZZ
    ) {
      errors.push(
        `${at}.priceBuzz must be a whole number between ${BLOCK_GOOD_MIN_PRICE_BUZZ} and ${BLOCK_GOOD_MAX_PRICE_BUZZ} Buzz`
      );
      return;
    }

    if (kind !== undefined && !isBlockGoodKind(kind)) {
      errors.push(`${at}.kind must be one of ${BLOCK_GOOD_KINDS.join(', ')}`);
      return;
    }

    if (payload !== undefined) {
      if (!isPlainObject(payload)) {
        errors.push(`${at}.payload must be an object`);
        return;
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        errors.push(`${at}.payload must be JSON-serializable`);
        return;
      }
      // TextEncoder, not Buffer: this module is imported by the manifest
      // validator, which is deliberately client-bundle-safe.
      if (new TextEncoder().encode(serialized).length > BLOCK_GOOD_PAYLOAD_MAX_BYTES) {
        errors.push(
          `${at}.payload must serialize to at most ${BLOCK_GOOD_PAYLOAD_MAX_BYTES} bytes`
        );
        return;
      }
    }

    goods.push({
      id,
      title: title.trim(),
      ...(typeof description === 'string' && description.trim().length > 0
        ? { description: description.trim() }
        : {}),
      priceBuzz,
      kind: isBlockGoodKind(kind) ? kind : BLOCK_GOOD_DEFAULT_KIND,
      payload: isPlainObject(payload) ? payload : {},
    });
  });

  return { goods, errors };
}

/**
 * Resolve ONE good from a stored manifest, by id.
 *
 * 🔴 Returns null when the manifest has ANY goods error, not just when the id
 * is missing. A manifest that no longer validates must not sell anything: the
 * alternative is charging for a catalog entry the current rules would reject.
 */
export function findManifestGood(
  manifest: GoodsManifestInput,
  goodId: string
): BlockGoodDeclaration | null {
  const { goods, errors } = parseManifestGoods(manifest);
  if (errors.length > 0) return null;
  return goods.find((good) => good.id === goodId) ?? null;
}
