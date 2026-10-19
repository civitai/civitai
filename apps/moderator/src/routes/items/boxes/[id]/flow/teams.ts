export const FALLBACK_TIER_COLOR = '#868e96';

const TEAM_COLORS: Record<string, string> = {
  Blue: '#4dabf7',
  Green: '#51cf66',
  Pink: '#f783ac',
  Yellow: '#fcc419',
};

export const teamColor = (team: string | null) =>
  team ? TEAM_COLORS[team] ?? FALLBACK_TIER_COLOR : FALLBACK_TIER_COLOR;
