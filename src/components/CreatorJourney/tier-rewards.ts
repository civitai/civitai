/**
 * What reaching a tier earns beyond feature unlocks. List a reward only once it is live. Every line is
 * ticked by the badge grant alone, never by showcase listing: the showcase leaves out silent grants and
 * creators not in good standing, and a tick must not reveal that to them.
 */
export const tierRewards: Partial<Record<string, string[]>> = {
  'score:supernova': [
    'Supernova badge',
    'A Supernova name plate on your username',
    'Eligible for New Supernovas on the Creator Showcase, the month you cross',
  ],
  'score:legend': [
    'Animated Legend badge',
    'An animated Legend name plate on your username',
    '"Legend since" and the month you crossed on your profile, or "Founding Legend" if you were already there at launch',
    'A place in the Creator Showcase Hall of Fame',
  ],
};
