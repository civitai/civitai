import { describe, expect, it } from 'vitest';
import {
  INVALID_BUNDLE_MESSAGE,
  submitVersionParseErrorMessage,
  submitVersionSchema,
} from '~/server/schema/blocks/publish-request.schema';

/**
 * `sdkFloorOverride` — what `civitai app submit --allow-outdated-sdk` overrode. Anti-strip: the
 * value must be PRESENT on `parsed.data` (a plain `z.object` drops an unknown key silently, which
 * would store nothing while looking like it worked). Deleting the field turns this red.
 */

const BUNDLE = Buffer.from('fake-zip-bytes').toString('base64');
const parse = (over: Record<string, unknown> = {}) =>
  submitVersionSchema.safeParse({ bundleBase64: BUNDLE, ...over });

describe('submitVersionSchema — sdkFloorOverride', () => {
  it('KEEPS the override on parsed.data (anti-strip)', () => {
    const parsed = parse({
      sdkFloorOverride: [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
        { package: '@civitai/blocks-react', installed: '0.80.2', minimum: '0.87.0' },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sdkFloorOverride).toEqual([
      { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
      { package: '@civitai/blocks-react', installed: '0.80.2', minimum: '0.87.0' },
    ]);
  });

  it('absent and null are both "none sent" (undefined, never null)', () => {
    for (const over of [{}, { sdkFloorOverride: null }]) {
      const parsed = parse(over);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.sdkFloorOverride).toBeUndefined();
    }
  });

  it('a malformed override REJECTS, naming the field (not the bundle)', () => {
    const parsed = parse({ sdkFloorOverride: [{ package: '@civitai/sdk', installed: 31 }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(submitVersionParseErrorMessage(parsed.error)).toBe(
      'Invalid submit payload: sdkFloorOverride must be a list of at most 8 { package, installed, minimum } strings'
    );
  });

  it('a bundle problem beside it still reads as the bundle message', () => {
    const parsed = submitVersionSchema.safeParse({ bundleBase64: '', sdkFloorOverride: 'x' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(submitVersionParseErrorMessage(parsed.error)).toBe(INVALID_BUNDLE_MESSAGE);
  });
});
