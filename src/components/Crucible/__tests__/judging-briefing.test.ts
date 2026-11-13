import { describe, expect, it } from 'vitest';
import {
  briefingKey,
  hasSeenBriefing,
  markBriefingSeen,
} from '~/components/Crucible/judging-briefing';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

const throwingStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('judging briefing seen flag', () => {
  it('keys by crucible id', () => {
    expect(briefingKey(12)).toBe('crucible-judge-briefing:12');
  });

  it('is unseen until marked, and only for that crucible', () => {
    const storage = memoryStorage();
    expect(hasSeenBriefing(1, storage)).toBe(false);
    markBriefingSeen(1, storage);
    expect(hasSeenBriefing(1, storage)).toBe(true);
    expect(hasSeenBriefing(2, storage)).toBe(false);
  });

  it('never throws when storage is unavailable, and reads as unseen', () => {
    expect(hasSeenBriefing(1, throwingStorage)).toBe(false);
    expect(() => markBriefingSeen(1, throwingStorage)).not.toThrow();
  });

  it('treats a missing storage as unseen', () => {
    expect(hasSeenBriefing(1, undefined)).toBe(false);
    expect(() => markBriefingSeen(1, undefined)).not.toThrow();
  });
});
