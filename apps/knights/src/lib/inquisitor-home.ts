import { count, percent } from './format';
import type { ModeratorStats } from './server/inquisitor/context';

export type InquisitorStat = {
  key: string;
  icon: 'inbox' | 'gavel' | 'check-check';
  value: string;
  label: string;
};

const UNKNOWN = '—';

/** A figure that could not be read shows a dash, not zero: a zero would claim an empty queue. */
export function inquisitorStats(stats: ModeratorStats | null): InquisitorStat[] {
  const waiting =
    stats?.waiting == null ? UNKNOWN : `${count(stats.waiting)}${stats.waitingMore ? '+' : ''}`;
  return [
    { key: 'waiting', icon: 'inbox', value: waiting, label: 'Waiting' },
    {
      key: 'votes',
      icon: 'gavel',
      value: stats ? count(stats.votesThisWeek) : UNKNOWN,
      label: 'Votes · 7 days',
    },
    {
      key: 'agreement',
      icon: 'check-check',
      value: stats?.agreementRate == null ? UNKNOWN : percent(stats.agreementRate),
      label: 'Agreement',
    },
  ];
}
