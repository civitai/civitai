import type { ActionResult } from '@sveltejs/kit';
import type { SiteAppealRow, SiteAppealSubject } from '$lib/server/site-appeals.service';

export const rowTitle = (row: Pick<SiteAppealRow, 'subject' | 'context' | 'entityId'>): string => {
  const s = row.subject;
  if (s.kind === 'article') return s.title ?? `Article #${row.entityId}`;
  if (s.kind === 'model') return s.name ?? `Model #${row.entityId}`;
  if (s.kind === 'account')
    return s.bannedAt ? 'Banned account' : s.muted ? 'Muted account' : 'Account';
  return row.context?.subject ?? 'Other';
};

/**
 * What approving will change, said before the moderator confirms. `blocked` mirrors the server's
 * refusal, so the control is not offered when its one outcome is an error.
 */
export function approvalEffect(
  subject: SiteAppealSubject,
  canBan: boolean
): { text: string; blocked: string | null } {
  switch (subject.kind) {
    case 'account': {
      const lifts = [subject.bannedAt && 'the ban', subject.muted && 'the mute'].filter(Boolean);
      return {
        text: lifts.length
          ? `Approving lifts ${lifts.join(' and ')}.`
          : 'The account is no longer restricted, so approving lifts nothing.',
        blocked:
          subject.bannedAt && !canBan
            ? 'Approving lifts a ban, which needs the Ban permission.'
            : null,
      };
    }
    case 'article':
    case 'model': {
      const noun = subject.kind;
      const gone = subject.kind === 'model' ? subject.deleted || !subject.status : !subject.status;
      const text = gone
        ? `The ${noun} no longer exists, so approving restores nothing.`
        : subject.status === 'UnpublishedViolation'
        ? `Approving republishes the ${noun}.`
        : subject.status === 'Published'
        ? `The ${noun} is already published, so approving restores nothing.`
        : `The ${noun} is ${subject.status}, not removed by a moderator, so approving restores nothing.`;
      return { text, blocked: null };
    }
    case 'other':
      return {
        text: 'Approving records the decision only; nothing changes on the site.',
        blocked: null,
      };
  }
}

const LIFTED: Record<string, string> = {
  ban: 'unbanned',
  mute: 'unmuted',
  article: 'article republished',
  model: 'model republished',
};

/** The decided row's label, naming what the approval actually lifted. */
export function outcomeLabel(result: ActionResult, outcome: string): string {
  if (result.type !== 'success') return outcome;
  const lifted = result.data?.lifted;
  if (!Array.isArray(lifted) || !lifted.length) return outcome;
  return `${outcome}: ${lifted.map((l) => LIFTED[String(l)] ?? String(l)).join(', ')}`;
}
