// The caps themselves are never shown: vote pacing is not described to players (see apps/knights/CLAUDE.md).
const NAMES: Record<number, string> = {
  60: 'per-minute vote limit',
  3600: 'hourly vote limit',
  86400: 'daily vote limit',
};

/** The limit as players read it ("the daily vote limit"); null when the window that set the pause is unknown. */
export function limitPhrase(windowSeconds: number | null): string | null {
  if (!windowSeconds) return null;
  return `the ${NAMES[windowSeconds] ?? 'vote limit'}`;
}

/** The answer to a vote refused for pace: names the limit when it is known. */
export function limitedMessage(windowSeconds: number | null): string {
  const phrase = limitPhrase(windowSeconds);
  return phrase
    ? `You reached ${phrase}. Voting reopens when the countdown ends.`
    : 'You are judging too quickly. Rest a little.';
}
