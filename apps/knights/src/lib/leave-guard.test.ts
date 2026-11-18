import { describe, expect, it } from 'vitest';
import { leaveAction, watchInProgress } from './leave-guard';

describe('watchInProgress', () => {
  it('is false before the first vote of the day', () => {
    expect(watchInProgress({ votes: 0, watchDone: false })).toBe(false);
  });

  it('is true between the first vote and completion', () => {
    expect(watchInProgress({ votes: 3, watchDone: false })).toBe(true);
  });

  it('is false once the Watch is complete, however many votes follow', () => {
    expect(watchInProgress({ votes: 12, watchDone: true })).toBe(false);
  });
});

describe('leaveAction', () => {
  const base = { inProgress: true, type: 'link', toPath: '/codex' } as const;

  it('lets everything through when no Watch is in progress', () => {
    expect(leaveAction({ ...base, inProgress: false })).toBe('allow');
    expect(leaveAction({ ...base, inProgress: false, type: 'leave', toPath: null })).toBe('allow');
  });

  it('asks before another screen, by link, goto or Back', () => {
    expect(leaveAction(base)).toBe('confirm');
    expect(leaveAction({ ...base, type: 'goto' })).toBe('confirm');
    expect(leaveAction({ ...base, type: 'popstate' })).toBe('confirm');
  });

  it('lets the Watch screen navigate to itself', () => {
    expect(leaveAction({ ...base, toPath: '/play' })).toBe('allow');
  });

  it('leaves the question to the browser when the page unloads', () => {
    expect(leaveAction({ ...base, type: 'leave', toPath: null })).toBe('native');
  });
});
