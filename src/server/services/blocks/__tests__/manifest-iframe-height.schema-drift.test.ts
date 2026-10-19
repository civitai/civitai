import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Drift guard — the manifest `iframe` height envelope.
 *
 * TWO places declare these bounds and they must never diverge:
 *   1. the canonical published schema `public/schemas/app-block/v1.json` — what
 *      the Go CLI byte-mirrors (re-vendored from the LIVE published copy by
 *      `.github/workflows/revendor-canonical-schema.yml` in `civitai/cli`) and
 *      what editors validate against;
 *   2. the IMPERATIVE validator in
 *      `src/server/services/block-manifest-validator.service.ts`, which is the
 *      authoritative gate at submit/approve — the JSON schema is a shape hint.
 *
 * 🔴 THE ASYMMETRY IS THE THING UNDER GUARD, not the numbers on their own.
 * `minHeight` is capped at 800 and `maxHeight` at 4000, and they used to share
 * one constant. Each direction of collapsing them back is a distinct, severe
 * failure:
 *
 *   - raising `minHeight` back to 4000 re-opens the defect the host's viewport
 *     clamp exists to prevent. The host clamp (`clampBlockHeight`, added by #4589) computes
 *     `Math.max(min, viewportBudget)`, so a large `minHeight` overrides the
 *     clamp outright — measured at 390x640 with `{minHeight: 4000}`, the applied
 *     height was 4000 WITH the clamp present;
 *   - lowering `maxHeight` to 800 rejects the ENTIRE live population: all 11
 *     approved blocks declare `maxHeight: 4000`.
 *
 * So the bounds are asserted INDEPENDENTLY, and each assertion says which
 * failure it is standing in front of. A single "both are in range" check would
 * be satisfied by either collapse.
 *
 * 🔴 STRUCTURAL + BEHAVIOURAL, deliberately. Reading the schema's numbers proves
 * only what one JSON file says; the validator is what actually rejects a
 * manifest, and the two are separate code paths. Each case therefore checks the
 * declared number AND drives the validator across the boundary.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

/** The largest `minHeight` in the live approved population (11 of 11 measured). */
const LARGEST_LIVE_MIN_HEIGHT = 700;
/** The `maxHeight` every live approved block declares (11 of 11). */
const LIVE_MAX_HEIGHT = 4000;

const MIN_HEIGHT_CEILING = 800;
const MAX_HEIGHT_CEILING = 4000;
const HEIGHT_FLOOR = 40;

// Mirrors the APP_CTX in block-manifest-validator.service.test.ts: `iframe.src`
// is gated against the app's registered allowedOrigins, so a bare scope value
// defaults allowedOrigins to [] and every manifest here would be rejected for a
// reason that has nothing to do with heights.
const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};

const BASE = {
  blockId: 'test-block',
  version: '1.0.0',
  name: 'Test Block',
  contentRating: 'g',
  renderMode: 'iframe',
  trustTier: 'unverified',
  scopes: ['models:read:self'],
  iframe: {
    src: 'https://blocks.civitai.com/test',
    minHeight: 200,
    maxHeight: null as number | null,
    resizable: true,
    sandbox: 'allow-scripts',
  },
};

const validateWith = (over: Record<string, unknown>) =>
  BlockManifestValidator.validate(
    { ...BASE, iframe: { ...BASE.iframe, ...over } },
    APP_CTX as never
  );

describe('app-block v1 schema ⇄ iframe height envelope drift guard', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    properties?: {
      iframe?: {
        properties?: {
          minHeight?: { minimum?: unknown; maximum?: unknown };
          maxHeight?: { minimum?: unknown; maximum?: unknown };
        };
      };
    };
  };
  const heights = () => schema.properties?.iframe?.properties;

  it('the schema caps minHeight at 800 — the bound that keeps a publisher floor from overriding the viewport clamp', () => {
    expect(
      heights()?.minHeight?.maximum,
      'the canonical schema no longer caps `iframe.minHeight` at 800. At 4000 a single ' +
        'schema-legal field reproduces the exact defect the host viewport clamp exists to ' +
        'prevent, because the host clamp (#4589) honours `Math.max(min, viewportBudget)`.'
    ).toBe(MIN_HEIGHT_CEILING);
    expect(heights()?.minHeight?.minimum).toBe(HEIGHT_FLOOR);
  });

  it('the schema leaves maxHeight at 4000 — tightening it would reject every live block', () => {
    expect(
      heights()?.maxHeight?.maximum,
      'the canonical schema changed `iframe.maxHeight`. All 11 live approved blocks declare ' +
        'exactly 4000, so any ceiling below that rejects the entire population at once.'
    ).toBe(MAX_HEIGHT_CEILING);
    expect(heights()?.maxHeight?.minimum).toBe(HEIGHT_FLOOR);
  });

  it('the VALIDATOR agrees with the schema at the minHeight boundary', () => {
    // The schema numbers above are a claim about one JSON file. This is the gate.
    expect(
      validateWith({ minHeight: MIN_HEIGHT_CEILING }).valid,
      `minHeight ${MIN_HEIGHT_CEILING} sits exactly on the declared ceiling and must be accepted`
    ).toBe(true);
    expect(
      validateWith({ minHeight: MIN_HEIGHT_CEILING + 1 }).valid,
      `minHeight ${MIN_HEIGHT_CEILING + 1} is over the declared ceiling and must be rejected — ` +
        'the schema and the imperative validator have drifted'
    ).toBe(false);
  });

  it('the VALIDATOR still accepts the live population, both bounds at once', () => {
    // The regression that a numbers-only guard cannot see: both live values in
    // one manifest, through the real gate.
    expect(
      validateWith({ minHeight: LARGEST_LIVE_MIN_HEIGHT, maxHeight: LIVE_MAX_HEIGHT }).valid,
      `the tallest live declaration (minHeight ${LARGEST_LIVE_MIN_HEIGHT}, maxHeight ` +
        `${LIVE_MAX_HEIGHT}) no longer validates — this change was supposed to reject nothing ` +
        'that exists today'
    ).toBe(true);
  });
});
