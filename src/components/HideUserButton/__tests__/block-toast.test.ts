import { describe, expect, it } from 'vitest';
import { blockToast } from '~/components/HideUserButton/block-toast';

describe('blockToast', () => {
  it('says nothing about comments when the switch was off', () => {
    expect(blockToast(undefined)).toEqual({
      kind: 'success',
      title: 'User blocked',
      message: 'Content from this user will not show up in your feed.',
    });
  });

  it('reports the count, and never claims there were none to hide', () => {
    expect(blockToast({ status: 'hidden', count: 0, capped: false }).message).toBe(
      'Content from this user will not show up in your feed. Hid 0 of their comments on your content.'
    );
  });

  it('warns that some are still visible at the ceiling', () => {
    const toast = blockToast({ status: 'hidden', count: 10_000, capped: true });

    expect(toast.kind).toBe('warning');
    expect(toast.message).toContain('so some are still visible');
  });

  it('keeps the partial count when a later batch failed', () => {
    expect(blockToast({ status: 'failed', count: 200 })).toEqual({
      kind: 'warning',
      title: 'User blocked, but hiding their comments failed',
      message:
        'Content from this user will not show up in your feed. Hid 200 of their comments on your content. Some of their comments on your content may still be visible to others.',
    });
  });
});
