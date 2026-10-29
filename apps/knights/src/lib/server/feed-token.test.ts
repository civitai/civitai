import { describe, expect, it } from 'vitest';
import { openItem, sealItem } from './feed-token';

describe('feed tokens', () => {
  it('round-trips an item for its player', () => {
    const token = sealItem('s', 7, { kind: 'hidden', id: 42 });
    expect(openItem('s', 7, token)).toEqual({ kind: 'hidden', id: 42 });
  });

  it('refuses another player, another secret and a tampered token', () => {
    const token = sealItem('s', 7, { kind: 'queue', id: 1 });
    expect(openItem('s', 8, token)).toBeNull();
    expect(openItem('other', 7, token)).toBeNull();
    expect(openItem('s', 7, token.slice(0, -2) + 'AA')).toBeNull();
    expect(openItem('s', 7, 'nonsense')).toBeNull();
  });

  it('gives a check and a queue item the same shape', () => {
    const a = sealItem('s', 7, { kind: 'hidden', id: 5 });
    const b = sealItem('s', 7, { kind: 'queue', id: 12345 });
    expect(a).toHaveLength(b.length);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
