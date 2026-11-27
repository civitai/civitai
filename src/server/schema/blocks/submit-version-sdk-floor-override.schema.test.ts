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

  it('a malformed override REJECTS naming the field; a bundle problem beside it still reads as the bundle', () => {
    const reject = (body: Record<string, unknown>) => {
      const parsed = submitVersionSchema.safeParse(body);
      expect(parsed.success).toBe(false);
      return parsed.success ? null : submitVersionParseErrorMessage(parsed.error);
    };
    expect(
      reject({
        bundleBase64: BUNDLE,
        sdkFloorOverride: [{ package: '@civitai/sdk', installed: 31 }],
      })
    ).toBe(
      'Invalid submit payload: sdkFloorOverride must be a list of at most 8 { package, installed, minimum } strings'
    );
    expect(reject({ bundleBase64: '', sdkFloorOverride: 'x' })).toBe(INVALID_BUNDLE_MESSAGE);
  });
});
