import { describe, expect, it } from 'vitest';
import { toSemanticBountySearchInput } from '~/components/Bounty/bounty.utils';
import { BountySort, BountyStatus } from '~/server/common/enums';
import { BountyMode, BountyType, MetricTimeframe } from '~/shared/utils/prisma/enums';

describe('toSemanticBountySearchInput', () => {
  it("sends the feed's filters the search takes, and leaves sort and period out", () => {
    expect(
      toSemanticBountySearchInput(
        {
          types: [BountyType.LoraCreation],
          mode: BountyMode.Individual,
          status: BountyStatus.Open,
          baseModels: ['SDXL 1.0'],
          userId: 7,
          sort: BountySort.HighestBounty,
          period: MetricTimeframe.Week,
        },
        'dragon',
        3
      )
    ).toEqual({
      query: 'dragon',
      browsingLevel: 3,
      types: [BountyType.LoraCreation],
      mode: BountyMode.Individual,
      status: BountyStatus.Open,
      baseModels: ['SDXL 1.0'],
      userId: 7,
    });
  });
});
