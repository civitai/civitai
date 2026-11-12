import { describe, expect, it } from 'vitest';
import { getAppEarningsSchema } from '~/server/schema/blocks/app-collaborator.schema';

describe('getAppEarningsSchema range', () => {
  it('takes a minute-precision range, read as :00', () => {
    expect(
      getAppEarningsSchema.parse({
        appListingId: 'app_1',
        from: '2026-09-01T00:00Z',
        to: '2026-09-30T23:59Z',
      })
    ).toMatchObject({ from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:00Z' });
  });
});
