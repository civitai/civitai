import type { MyChallengeResult } from '~/server/services/challenge-participation.util';

export type MyChallengeCtaKind = 'results' | 'entry' | 'add';

export function getMyChallengeCta(
  result: MyChallengeResult,
  isLive: boolean
): { kind: MyChallengeCtaKind; label: string; filled: 'white' | 'blue' } {
  if (result === 'judging') return { kind: 'entry', label: 'View entry', filled: 'white' };
  if (result === 'entered' && isLive)
    return { kind: 'add', label: 'Add another entry', filled: 'blue' };
  return { kind: 'results', label: 'View results', filled: 'white' };
}

export function getMyChallengeBadge(
  result: MyChallengeResult,
  myPlace: number | null
): { label: string; color: 'gold' | 'dark' | 'blue' | 'green'; icon: 'trophy' | 'medal' | 'hourglass' | 'check' } {
  switch (result) {
    case 'won':
      return { label: 'Won', color: 'gold', icon: 'trophy' };
    case 'placed':
      return { label: `#${myPlace ?? ''} Placed`, color: 'dark', icon: 'medal' };
    case 'judging':
      return { label: 'Judging', color: 'blue', icon: 'hourglass' };
    default:
      return { label: 'Entered', color: 'green', icon: 'check' };
  }
}
