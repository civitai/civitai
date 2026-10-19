const TEAM_COLORS: Record<string, string> = {
  Blue: '#4dabf7',
  Green: '#51cf66',
  Pink: '#f783ac',
  Yellow: '#fcc419',
};

/** An event's team dot; a team this screen has no colour for gets a neutral one. */
export const teamColor = (team: string | null) => (team ? (TEAM_COLORS[team] ?? '#868e96') : '#868e96');

export const FALLBACK_TIER_COLOR = '#868e96';
export const percent = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 3 : p < 0.1 ? 2 : 1)}%`;
