// Reactions over a range split by whether the reactor follows the creator *now* — follow state is current, not
// as-of-reaction, because `UserEngagement` keeps no history. `self` is the creator reacting to their own content
// (0–3% for the heaviest creators, never zero), broken out rather than dropped so the three buckets sum to the
// `reactions` total on the same page; two creator-facing reaction numbers that disagree read as a bug.
export type AudienceBucket = { reactions: number; reactors: number };
export type ReactionAudienceSplit = {
  followers: AudienceBucket;
  nonFollowers: AudienceBucket;
  self: AudienceBucket;
};

export function bucketReactors(
  reactors: { id: number; reactions: number }[],
  ownerId: number,
  followerIds: Set<number>
): ReactionAudienceSplit {
  const split: ReactionAudienceSplit = {
    followers: { reactions: 0, reactors: 0 },
    nonFollowers: { reactions: 0, reactors: 0 },
    self: { reactions: 0, reactors: 0 },
  };
  for (const r of reactors) {
    const bucket =
      r.id === ownerId ? split.self : followerIds.has(r.id) ? split.followers : split.nonFollowers;
    bucket.reactions += r.reactions;
    // A reactor who reacted and un-reacted inside the range nets to 0 and isn't a person who reacted; their
    // (possibly negative) contribution still belongs in the sum so it reconciles with the reactions total.
    if (r.reactions > 0) bucket.reactors += 1;
  }
  return split;
}
