/**
 * What reaching a tier earns beyond feature unlocks. List a reward only once it is live: the animated
 * Legend badge joins when it is delivered and swapped in.
 */
export const tierRewards: Partial<Record<string, string[]>> = {
  'score:supernova': [
    'Supernova badge',
    'A Supernova name plate on your username',
    'A spot in New Supernovas on the Creator Showcase, the month you cross',
  ],
  'score:legend': [
    'Legend badge',
    '"Legend since" and the month you crossed on your profile, or "Founding Legend" if you were already there at launch',
    'A permanent place in the Creator Showcase Hall of Fame',
  ],
};
