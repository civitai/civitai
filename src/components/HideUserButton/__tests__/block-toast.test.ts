import { describe, expect, it } from 'vitest';
import { blockToast } from '~/components/HideUserButton/block-toast';

const BLOCKED = 'Content from this user will not show up in your feed.';

// Counts stay under 1,000 so toLocaleString adds no separator and the text is locale-independent.
describe('blockToast', () => {
  it('says nothing about comments when the switch was off', () => {
    expect(blockToast(undefined)).toEqual({
      kind: 'success',
      title: 'User blocked',
      message: BLOCKED,
    });
  });

  it('reports the count, and never claims there were none to hide', () => {
    expect(blockToast({ status: 'hidden', count: 0, capped: false })).toEqual({
      kind: 'success',
      title: 'User blocked',
      message: `${BLOCKED} Hid 0 of their comments on your content.`,
    });
  });

  it('warns that some are still visible at the ceiling', () => {
    expect(blockToast({ status: 'hidden', count: 900, capped: true })).toEqual({
      kind: 'warning',
      title: 'User blocked',
      message: `${BLOCKED} Hid 900 of their comments on your content. That is the most we hide at once, so some are still visible. You can hide them one at a time.`,
    });
  });

  it('tells the user when the hide was asked for but did not run', () => {
    expect(blockToast({ status: 'skipped' })).toEqual({
      kind: 'warning',
      title: 'User was already blocked',
      message:
        'Their comments were not hidden, because hiding runs when you first block someone. To hide them, unblock this user and block them again with the switch on.',
    });
  });

  it('does not claim a count when nothing was hidden before the failure', () => {
    expect(blockToast({ status: 'failed', count: 0 })).toEqual({
      kind: 'warning',
      title: 'User blocked, but hiding their comments failed',
      message: `${BLOCKED} Some of their comments on your content may still be visible to others.`,
    });
  });

  it('keeps the partial count when a later batch failed', () => {
    expect(blockToast({ status: 'failed', count: 200 })).toEqual({
      kind: 'warning',
      title: 'User blocked, but hiding their comments failed',
      message: `${BLOCKED} Hid 200 of their comments on your content. Some of their comments on your content may still be visible to others.`,
    });
  });
});
