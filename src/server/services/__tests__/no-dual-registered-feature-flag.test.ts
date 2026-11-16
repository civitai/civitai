import { describe, expect, it } from 'vitest';
import {
  dualRegisteredFlags,
  FEATURE_FLAGS_FILE,
  FLIPT_ENUM_FILE,
  readSource,
} from './source-ratchet.harness';

/**
 * RATCHET: Flipt keys registered twice — in `enum FLIPT_FEATURE_FLAGS`
 * (`src/server/flipt/client.ts`) AND as a `fliptKey` in `feature-flags.service.ts`.
 *
 * The enum plus `isFlipt` / `isFliptSync` is the single source for a Flipt-backed flag. A key in
 * both places has two readers with different defaults and caching, and they can disagree about
 * the same flag. This freezes the set: a new key in both fails, and a key removed from either
 * side must leave the baseline in the same commit, so the list only shrinks.
 *
 * `fliptKey` values are resolved from a string literal, `FLIPT_FEATURE_FLAGS.X`, or an imported
 * `export const X = '…'`. Any other value expression fails the guard rather than hiding a key.
 * Only a `fliptKey: <value>` property is read: the shorthand `{ fliptKey }` and a quoted
 * `'fliptKey':` name are skipped.
 *
 * Known gap: this catches a key registered in BOTH places only. A new flag registered solely as
 * a `fliptKey` in feature-flags.service.ts, bypassing the enum, passes.
 */

const BASELINE: string[] = [
  'ai-toolkit-default-sd',
  'ai-toolkit-flux',
  'ai-toolkit-hunyuan',
  'ai-toolkit-sd15',
  'ai-toolkit-sdxl',
  'ai-toolkit-wan',
  'article-rating-dispute',
  'challenge-platform-enabled',
  'comic-creator',
  'early-adopter',
  'enhanced-compatibility-sdcpp',
  'flux2-klein-training',
  'flux2-training',
  'generation-presets',
  'image-index-feed',
  'knights-of-new-order-app',
  'licensing-fee',
  'ltx2-training',
  'ltx23-training',
  'ltx25-training',
  'rating-dispute',
  'text-blurbs',
  'wildcards',
  'zimage-base-training',
  'zimage-turbo-training',
];

const MESSAGE_GROWN =
  'Flipt key registered twice. The FLIPT_FEATURE_FLAGS enum plus isFlipt / isFliptSync is the ' +
  'single source: read the flag through the enum and drop the fliptKey from feature-flags.service.ts.';
const MESSAGE_SHRUNK =
  'These keys are no longer registered in both places. Remove them from BASELINE in ' +
  'no-dual-registered-feature-flag.test.ts, in this commit.';

describe('no Flipt key registered in both the enum and feature-flags.service (ratchet)', () => {
  const result = dualRegisteredFlags(readSource(FLIPT_ENUM_FILE), readSource(FEATURE_FLAGS_FILE));

  it('reads both registries completely', () => {
    expect(result.enum.found, `enum FLIPT_FEATURE_FLAGS not found in ${FLIPT_ENUM_FILE}`).toBe(
      true
    );
    expect(result.enum.keys.size).toBeGreaterThan(0);
    expect(result.enum.unread, 'enum members without a string value').toEqual([]);
    expect(result.flags.keys.length).toBeGreaterThan(0);
    expect(
      result.flags.unresolved,
      'fliptKey values this guard cannot resolve to a string; teach fliptKeysOfFeatureFlags the shape'
    ).toEqual([]);
  });

  it('positive control: a key on both sides is found, one on a single side is not', () => {
    const enumSrc = "export enum FLIPT_FEATURE_FLAGS { A = 'key-a', B = 'key-b' }";
    const flagsSrc =
      "const featureFlags = createFeatureFlags({ x: { fliptKey: 'key-a' }, y: { fliptKey: FLIPT_FEATURE_FLAGS.B }, z: { fliptKey: 'key-c' } });";
    expect(dualRegisteredFlags(enumSrc, flagsSrc).dual).toEqual(['key-a', 'key-b']);
  });

  it('no new key is registered in both places', () => {
    expect(
      result.dual.filter((k) => !BASELINE.includes(k)),
      MESSAGE_GROWN
    ).toEqual([]);
  });

  it('the baseline matches the code (the list may only shrink)', () => {
    expect(
      BASELINE.filter((k) => !result.dual.includes(k)),
      MESSAGE_SHRUNK
    ).toEqual([]);
  });
});
