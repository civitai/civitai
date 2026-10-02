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

/**
 * Ceiling on an `app_unlock` good specifically — the price of ADMISSION to an
 * app, which is a different question from the price of an item inside one.
 *
 * 🔴 WHY 5,000 AND NOT THE GENERAL 50,000. An app unlock is the one purchase a
 * viewer is asked to make BEFORE they have used the app, so they are paying
 * against a store listing rather than against experience. 5,000 Buzz is the
 * platform's existing answer to "how much Buzz may one click move out of a
 * wallet on an App Blocks surface?" — it is exactly `BLOCK_TIP_MAX_PER_TIP`
 * (`src/server/utils/block-tip-rate-limit.ts`), the per-single-tip ceiling that
 * made `social:tip:self` safe enough to come off `PAGE_FORBIDDEN_SCOPES`. It is
 * also $5 at `buzzConstants.buzzDollarRatio` (1,000 Buzz = $1), which is
 * `buzzConstants.minStripeChargeAmount` — the smallest top-up a viewer can
 * actually buy — so the ceiling never exceeds what one Buzz purchase funds.
 *
 * 🔴 Deliberately NOT an alias of `BLOCK_TIP_MAX_PER_TIP`. Same reasoning as
 * `BLOCK_GOOD_APP_OWNER_SHARE` vs the creator shop's share: the two are the same
 * number by POLICY, not by construction, and aliasing would make a tipping
 * repricing silently reprice every paid app in a different product with no
 * review. Independent knobs that currently agree.
 *
 * Enforced in `parseManifestGoods`, which is also what the purchase path reaches
 * through `findManifestGood` — so an over-ceiling unlock is unsellable as well
 * as unapprovable, with no second copy of the bound. The JSON Schema's outer
 * `priceBuzz` bound stays 2..50000 on purpose: the schema declares the
 * imperative validator authoritative, and a conditional `if/then` on `kind`
 * there is more surface than this one property is worth. The narrower bound is
 * STATED in the schema's `kind` description so the published docs do not lie.
 */
export const BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ = 5_000;

/**
 * THE per-kind price ceiling, in ONE place. Every caller that needs to know what
 * a good of a given kind may cost reads this rather than re-deriving the
 * `kind === 'app_unlock'` branch — a predicate open-coded at N sites is wrong at
 * N−1 of them, which is the defect shape `requestConsentGate.ts` records for the
 * host-side consent backstop.
 */
export function maxPriceBuzzForKind(kind: BlockGoodKind): number {
  return kind === 'app_unlock' ? BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ : BLOCK_GOOD_MAX_PRICE_BUZZ;
}

/** Most goods one manifest may declare. */
export const BLOCK_GOOD_MAX_PER_MANIFEST = 32;

/**
 * Most `app_unlock` goods one manifest may declare.
 *
 * 🔴 ONE, SO A FUTURE GATE'S PREDICATE IS TOTAL. "Is this viewer allowed into
 * this app?" has a single answer, so the question "which unlock did they buy?"
 * must not exist. At the general `BLOCK_GOOD_MAX_PER_MANIFEST` an app could
 * declare 32 unlocks and the access gate would have to pick one, or hold them
 * all, or decide what a partial set means — three branches with no right answer,
 * none of which any reviewer would have been shown. Bounding the arity here
 * means the later gate is `exists(entitlement where kind='app_unlock')` and
 * nothing more.
 */
export const BLOCK_APP_UNLOCK_MAX_PER_MANIFEST = 1;

/**
 * Length bound on a good's review `justification`. Agrees with
 * `SCOPE_JUSTIFICATION_MAX_LENGTH` (the per-scope rationale bound) by POLICY
 * rather than by construction — same independent-knobs reasoning as the share
 * constant above, and it keeps this module free of an auth-package import it
 * otherwise has no need for.
 */
export const BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH = 500;

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
 *
 * 🔴 `app_unlock` IS NOT MERELY A LABEL ANY MORE, even though no access gate reads
 * it yet. It carries three manifest-time rules the ordinary kind does not: a lower
 * price ceiling (`BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ`), an arity of
 * `BLOCK_APP_UNLOCK_MAX_PER_MANIFEST`, and a mandatory `justification`. All three
 * exist so the later gate inherits a catalog it can reason about — bounded price,
 * one answer, and a reviewed reason — rather than having to defend itself against
 * one.
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
  /**
   * The developer's stated reason this good exists, shown to the moderator at
   * review. REQUIRED for `app_unlock` (see `parseManifestGoods`), optional for an
   * ordinary good. Review metadata only — unlike `payload` it is never copied
   * onto an entitlement, and the platform does not verify the claim.
   */
  justification?: string;
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

    const { id, title, description, priceBuzz, kind, payload, justification } = entry;

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

    // KIND IS RESOLVED BEFORE THE PRICE, because the price ceiling DEPENDS on it
    // (`maxPriceBuzzForKind`). Reading them in the other order is how a per-kind
    // bound ends up checked against the general ceiling and silently admits an
    // over-priced unlock.
    if (kind !== undefined && !isBlockGoodKind(kind)) {
      errors.push(`${at}.kind must be one of ${BLOCK_GOOD_KINDS.join(', ')}`);
      return;
    }
    const resolvedKind: BlockGoodKind = isBlockGoodKind(kind) ? kind : BLOCK_GOOD_DEFAULT_KIND;
    const maxPriceBuzz = maxPriceBuzzForKind(resolvedKind);

    if (
      typeof priceBuzz !== 'number' ||
      !Number.isSafeInteger(priceBuzz) ||
      priceBuzz < BLOCK_GOOD_MIN_PRICE_BUZZ ||
      priceBuzz > maxPriceBuzz
    ) {
      errors.push(
        `${at}.priceBuzz must be a whole number between ${BLOCK_GOOD_MIN_PRICE_BUZZ} and ${maxPriceBuzz} Buzz` +
          (resolvedKind === 'app_unlock' ? ` for a ${resolvedKind} good` : '')
      );
      return;
    }

    // THE FREE→PAID REVIEW TRIGGER. An `app_unlock` good is what turns a free app
    // into a paid one, and the existing sensitive-scope gate does not catch it:
    // that gate fires on a declared SENSITIVE scope, and an app unlock is designed
    // not to require `goods:purchase:self`. Without this rule a v2 could add an
    // unlock and flip a free app to paid with nothing for a moderator to read.
    // Requiring the rationale HERE — in the one parser both the submit gate and
    // the purchase path call — is what makes "becoming paid" an explicit,
    // reviewed claim rather than a diff nobody was pointed at.
    //
    // Shape-checked for ANY good so a developer who explains an ordinary item is
    // not rejected for it; REQUIRED only for `app_unlock`.
    if (justification !== undefined) {
      if (typeof justification !== 'string' || justification.trim().length === 0) {
        errors.push(`${at}.justification must be a non-empty string`);
        return;
      }
      if (justification.trim().length > BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH) {
        errors.push(
          `${at}.justification must be at most ${BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH} characters`
        );
        return;
      }
    } else if (resolvedKind === 'app_unlock') {
      errors.push(
        `${at}.justification is required for an ${resolvedKind} good — it makes the app paid, so a moderator must be told why`
      );
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
      kind: resolvedKind,
      ...(typeof justification === 'string' && justification.trim().length > 0
        ? { justification: justification.trim() }
        : {}),
      payload: isPlainObject(payload) ? payload : {},
    });
  });

  // ARITY OF THE UNLOCK, checked across the whole catalog rather than per entry.
  // Counted over the ACCEPTED declarations: an entry that already failed above has
  // its own error and the manifest is rejected either way, so counting rejects too
  // would only produce a second message about the same bad entry.
  const appUnlockCount = goods.filter((good) => good.kind === 'app_unlock').length;
  if (appUnlockCount > BLOCK_APP_UNLOCK_MAX_PER_MANIFEST) {
    errors.push(
      `goods may declare at most ${BLOCK_APP_UNLOCK_MAX_PER_MANIFEST} app_unlock good (found ${appUnlockCount}) — app access is one question with one answer`
    );
  }

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
