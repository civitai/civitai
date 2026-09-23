import type { BlockHideCommentsResult } from '~/server/services/block-hide-comments.service';

const BLOCKED = 'Content from this user will not show up in your feed.';

const hidCount = (count: number) =>
  `Hid ${count.toLocaleString()} of their comments on your content.`;

export function blockToast(result: BlockHideCommentsResult | undefined): {
  kind: 'success' | 'warning';
  title: string;
  message: string;
} {
  if (!result) return { kind: 'success', title: 'User blocked', message: BLOCKED };

  if (result.status === 'skipped')
    return {
      kind: 'warning',
      title: 'User was already blocked',
      message:
        'Their comments were not hidden, because hiding runs when you first block someone. To hide them, unblock this user and block them again with the switch on.',
    };

  if (result.status === 'failed')
    return {
      kind: 'warning',
      title: 'User blocked, but hiding their comments failed',
      message: `${BLOCKED} ${
        result.count ? `${hidCount(result.count)} ` : ''
      }Some of their comments on your content may still be visible to others.`,
    };

  return {
    kind: result.capped ? 'warning' : 'success',
    title: 'User blocked',
    message: `${BLOCKED} ${hidCount(result.count)}${
      result.capped
        ? ' That is the most we hide at once, so some are still visible. You can hide them one at a time.'
        : ''
    }`,
  };
}
