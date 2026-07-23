import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import type { MyChallengeResult } from '~/server/schema/challenge.schema';
import { slugit } from '~/utils/string-helpers';

export type MyChallengeCtaKind = 'results' | 'entry' | 'add' | 'manage';

// The detail page reads `#entries` to scroll, `?mine=1` to seed the My Entries filter, and
// `?submit=1` to open the submit modal on arrival.
export function getMyChallengeCtaHref(
  kind: MyChallengeCtaKind,
  { id, title }: { id: number; title: string }
) {
  if (kind === 'manage') return `/challenges/${id}/edit`;
  const href = `/challenges/${id}/${slugit(title)}`;
  if (kind === 'entry') return `${href}?mine=1#entries`;
  if (kind === 'add') return `${href}?submit=1#entries`;
  return `${href}#entries`;
}

export function getMyChallengeCta(
  result: MyChallengeResult,
  isLive: boolean,
  status: ChallengeStatus
): { kind: MyChallengeCtaKind; label: string; filled: 'white' | 'blue' } {
  if (result === 'hosting') {
    // Before it starts, the only useful action is editing it — after that, looking at it.
    if (status === ChallengeStatus.Scheduled)
      return { kind: 'manage', label: 'Manage', filled: 'white' };
    return {
      kind: 'results',
      label: isLive || status === ChallengeStatus.Completing ? 'View entries' : 'View results',
      filled: 'white',
    };
  }
  if (result === 'judging') return { kind: 'entry', label: 'View entry', filled: 'white' };
  if (result === 'entered' && isLive)
    return { kind: 'add', label: 'Add another entry', filled: 'blue' };
  return { kind: 'results', label: 'View results', filled: 'white' };
}

export function getMyChallengeBadge(
  result: MyChallengeResult,
  myPlace: number | null
): {
  label: string;
  color: 'gold' | 'dark' | 'blue' | 'green' | 'grape';
  icon: 'trophy' | 'medal' | 'hourglass' | 'check' | 'crown';
} {
  switch (result) {
    case 'hosting':
      return { label: 'Hosting', color: 'grape', icon: 'crown' };
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
