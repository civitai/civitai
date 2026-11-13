export type Collector = {
  userId: number;
  username: string | null;
  image: string | null;
  /** When they first added it to a public collection. */
  collectedAt: string;
  /** Public collections of theirs that hold it. */
  collections: number;
  banned: boolean;
  /** Follows the owner now: `UserEngagement` keeps no history. */
  follows: boolean;
};

export type CollectorPage = {
  /** Distinct accounts with it in a public collection, not counting the owner. */
  total: number;
  collectors: Collector[];
  next: number | null;
  prev: number | null;
};
