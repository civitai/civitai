import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

/**
 * APP_REVIEW_AUTO_BUILD_FIXTURE_USER_IDS names the test-fixture accounts whose automatic review
 * builds are counted per app slug (review-autodeploy.service). `src/env/server.ts` throws on an
 * invalid field, so a typo must read as "no fixture accounts" (every account on the normal
 * budget), never crash the boot and never exempt an unintended id.
 */
const field = serverSchema.shape.APP_REVIEW_AUTO_BUILD_FIXTURE_USER_IDS;

describe('APP_REVIEW_AUTO_BUILD_FIXTURE_USER_IDS', () => {
  it('unset means no fixture accounts', () => {
    expect(field.parse(undefined)).toEqual([]);
  });

  it('parses a comma-separated id list', () => {
    expect(field.parse('2000000001')).toEqual([2000000001]);
    expect(field.parse('2000000001,2000000002')).toEqual([2000000001, 2000000002]);
  });

  it.each([
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['one bad entry poisons the list', '2000000001,abc'],
  ])('%s reads as no fixture accounts, without throwing', (_label, value) => {
    expect(() => field.parse(value)).not.toThrow();
    expect(field.parse(value)).toEqual([]);
  });
});
