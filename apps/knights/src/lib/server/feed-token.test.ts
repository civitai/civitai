import { describe, expect, it } from 'vitest';
import { MAX_MS_ON_ITEM, msOnItem, openItem, sealItem } from './feed-token';

describe('feed tokens', () => {
  it('round-trips an item for its player', () => {
    const token = sealItem('s', 7, { kind: 'hidden', id: 42 }, 1_700_000_000_000);
    expect(openItem('s', 7, token)).toEqual({
      kind: 'hidden',
      id: 42,
      issuedAt: 1_700_000_000_000,
    });
  });

  it('carries the issue time of the longest ids in the fixed size', () => {
    const big = sealItem(
      's',
      2_147_483_647,
      { kind: 'hidden', id: -2_147_483_647 },
      9_999_999_999_999
    );
    expect(openItem('s', 2_147_483_647, big)).toEqual({
      kind: 'hidden',
      id: -2_147_483_647,
      issuedAt: 9_999_999_999_999,
    });
    expect(big).toHaveLength(sealItem('s', 1, { kind: 'queue', id: 1 }).length);
  });

  it('refuses another player, another secret and a tampered token', () => {
    const token = sealItem('s', 7, { kind: 'queue', id: 1 });
    expect(openItem('s', 8, token)).toBeNull();
    expect(openItem('other', 7, token)).toBeNull();
    expect(openItem('s', 7, token.slice(0, -2) + 'AA')).toBeNull();
    expect(openItem('s', 7, 'nonsense')).toBeNull();
  });

  it('gives a check, a queue item and a yes/no question the same shape', () => {
    const a = sealItem('s', 7, { kind: 'hidden', id: 5 });
    const b = sealItem('s', 7, { kind: 'queue', id: 12345 });
    const c = sealItem('s', 7, { kind: 'yesno', id: 12345 });
    expect(openItem('s', 7, c)).toMatchObject({ kind: 'yesno', id: 12345 });
    expect(a).toHaveLength(c.length);
    expect(a).toHaveLength(b.length);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('time on item', () => {
  const issued = new Date('2026-12-20T12:00:00Z').getTime();
  const at = (ms: number) => new Date(issued + ms);

  it('is the time since the token was issued', () => {
    expect(msOnItem(issued, at(4_200))).toBe(4_200);
  });

  it('is clamped to 0..MAX_MS_ON_ITEM', () => {
    expect(msOnItem(issued, at(-5_000))).toBe(0);
    expect(msOnItem(issued, at(MAX_MS_ON_ITEM + 1))).toBe(MAX_MS_ON_ITEM);
    expect(MAX_MS_ON_ITEM).toBe(600_000);
  });

  it('is unknown without an issue time', () => {
    expect(msOnItem(null, at(1_000))).toBeNull();
  });
});
