import { describe, expect, it } from 'vitest';
import {
  clusterFingerprint,
  detectLinkedClusters,
  parseLinkDetectionConfig,
  type LinkDetectionConfig,
} from '~/server/games/new-order/link-detection';

const config: LinkDetectionConfig = {
  lookbackDays: 1,
  maxEarners: 100,
  maxTipRows: 100,
  ipMaxAccounts: 3,
  ipMinShared: 2,
  sinkMinShare: 0.5,
  sinkMinTips: 2,
  burstSeconds: 10,
  burstMinTips: 3,
  createdGapSeconds: 60,
  createdMinAccounts: 2,
  weights: { ip: 3, sink: 2, burst: 4, created: 8 },
  blockScore: 10,
  reviewScore: 2,
};

const tipsFrom = (from: number, to: number, count: number, startAt = 0, step = 1) =>
  Array.from({ length: count }, (_, i) => ({ from, to, amount: 100, at: startAt + i * step }));

const base = {
  earners: [1, 2, 3, 4, 10, 11],
  ipGroups: [],
  tips: [],
  accounts: [],
  config,
};

describe('detectLinkedClusters', () => {
  it('returns nothing when no signal is present', () => {
    expect(detectLinkedClusters(base)).toEqual([]);
  });

  it('scores a cluster by the configured weights and picks the decision from the score', () => {
    const review = detectLinkedClusters({
      ...base,
      tips: [...tipsFrom(1, 99, 2, 0, 1000), ...tipsFrom(2, 99, 2, 0, 1000)],
    });
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ userIds: [1, 2, 99], score: 2, decision: 'review' });
    expect(review[0].buzzMoved).toBe(400);

    const block = detectLinkedClusters({
      ...base,
      tips: [...tipsFrom(1, 99, 3, 0, 1), ...tipsFrom(2, 99, 3, 0, 1)],
      accounts: [
        { userId: 1, createdAt: new Date(0) },
        { userId: 2, createdAt: new Date(30_000) },
      ],
    });
    expect(block[0]).toMatchObject({ score: 14, decision: 'block' });
    expect(block[0].evidence.createdTogether).toEqual([[1, 2]]);
  });

  it('ignores address groups over the account ceiling or below the shared minimum', () => {
    const crowded = detectLinkedClusters({
      ...base,
      ipGroups: [
        { members: [1, 2], totalAccounts: 4 },
        { members: [1, 2], totalAccounts: 4 },
      ],
    });
    expect(crowded).toEqual([]);

    const single = detectLinkedClusters({
      ...base,
      ipGroups: [{ members: [1, 2], totalAccounts: 2 }],
    });
    expect(single).toEqual([]);

    const linked = detectLinkedClusters({
      ...base,
      ipGroups: [
        { members: [1, 2], totalAccounts: 2 },
        { members: [1, 2, 3], totalAccounts: 3 },
      ],
    });
    expect(linked[0].userIds).toEqual([1, 2]);
    expect(linked[0].evidence.ipLinks).toEqual([{ userIds: [1, 2], sharedIps: 2 }]);
  });

  it('keeps unrelated clusters apart', () => {
    const two = detectLinkedClusters({
      ...base,
      tips: [
        ...tipsFrom(1, 99, 2),
        ...tipsFrom(2, 99, 2),
        ...tipsFrom(10, 98, 2),
        ...tipsFrom(11, 98, 2),
      ],
    });
    expect(two.map((c) => c.userIds)).toEqual([
      [1, 2, 99],
      [10, 11, 98],
    ]);
  });

  it('does not treat a sender whose tips are spread out as feeding any one account', () => {
    const spread = [
      ...tipsFrom(1, 90, 2),
      ...tipsFrom(1, 91, 2),
      ...tipsFrom(1, 92, 2),
      ...tipsFrom(2, 90, 2),
      ...tipsFrom(2, 91, 2),
      ...tipsFrom(2, 92, 2),
    ];
    expect(detectLinkedClusters({ ...base, tips: spread })).toEqual([]);
  });
});

describe('parseLinkDetectionConfig', () => {
  it('returns null for missing or incomplete config', () => {
    expect(parseLinkDetectionConfig(null)).toBeNull();
    expect(parseLinkDetectionConfig({ lookbackDays: 1 })).toBeNull();
    expect(parseLinkDetectionConfig(config)).toEqual(config);
  });
});

describe('clusterFingerprint', () => {
  it('is stable regardless of member order', () => {
    expect(clusterFingerprint([3, 1, 2])).toBe(clusterFingerprint([1, 2, 3]));
    expect(clusterFingerprint([1, 2])).not.toBe(clusterFingerprint([1, 2, 3]));
  });
});
