import { describe, expect, it, vi } from 'vitest';
import {
  csamRestrictedSql,
  moderatorWithheldSql,
  siblingsServable,
  URL_SIBLING_CAP,
  urlSiblingsSql,
} from '../retracted-media-tier';
import type { ScannerVerdict } from '../media-signals';

describe('csamRestrictedSql, moderatorWithheldSql and urlSiblingsSql', () => {
  const aliases = (sql: string) => [
    ...new Set([...sql.matchAll(/(?:FROM|JOIN) "\w+" (\w+)/g)].map((m) => m[1])),
  ];

  it('refuse every alias their SQL declares, in any case', () => {
    const declared = aliases(csamRestrictedSql('i'));
    expect(declared).toContain('cs');
    for (const alias of declared) {
      expect({ alias, refused: refuses(() => csamRestrictedSql(alias)) }).toEqual({
        alias,
        refused: true,
      });
      const upper = alias.toUpperCase();
      expect({ upper, refused: refuses(() => csamRestrictedSql(upper)) }).toEqual({
        upper,
        refused: true,
      });
    }
    const withheld = (alias: string) => moderatorWithheldSql(alias, { csamReview: false });
    const declaredWithheld = aliases(withheld('i'));
    expect(declaredWithheld).toContain('mw');
    for (const alias of declaredWithheld)
      for (const a of [alias, alias.toUpperCase()])
        expect({ a, refused: refuses(() => withheld(a)) }).toEqual({ a, refused: true });
    expect(moderatorWithheldSql('i', { csamReview: true })).toBe('false');
    expect(() => urlSiblingsSql('us')).toThrow(/Bad table alias/);
    expect(() => urlSiblingsSql('US')).toThrow(/Bad table alias/);
    expect(() => urlSiblingsSql('i')).not.toThrow();
  });
});

const refuses = (build: () => string) => {
  try {
    build();
    return false;
  } catch {
    return true;
  }
};

describe('siblingsServable', () => {
  const isSignal = (blockedFor: string | null) => blockedFor === 'unlisted';
  const row = (id: number, blockedFor: string | null = null, unreadable = false) => ({
    id,
    blockedFor,
    unreadable,
  });
  const verdicts =
    (v: Record<number, ScannerVerdict>) =>
    async (ids: number[]): Promise<Map<number, ScannerVerdict> | null> =>
      new Map(ids.map((id) => [id, v[id] ?? 'clear']));

  it('serves a url no other row marks, whether the scanner cleared or never saw them', async () => {
    expect(await siblingsServable([], isSignal, verdicts({}))).toBe(true);
    expect(
      await siblingsServable([row(1, 'moderated'), row(2)], isSignal, verdicts({ 2: 'none' }))
    ).toBe(true);
  });

  it('refuses a url another row has a block-reason signal on', async () => {
    expect(await siblingsServable([row(1, 'unlisted')], isSignal, verdicts({}))).toBe(false);
  });

  it('refuses a url another row has not finished its scan on', async () => {
    expect(await siblingsServable([row(1, null, true)], isSignal, verdicts({}))).toBe(false);
    const unknown = { id: 1, blockedFor: null, unreadable: null as unknown as boolean };
    expect(await siblingsServable([unknown], isSignal, verdicts({}))).toBe(false);
  });

  it('refuses a url another row has a scanner hit on, or when the scanner cannot be read', async () => {
    expect(await siblingsServable([row(1), row(2)], isSignal, verdicts({ 2: 'hit' }))).toBe(false);
    expect(await siblingsServable([row(1)], isSignal, async () => null)).toBe(false);
  });

  it('reads every verdict in one call', async () => {
    const read = vi.fn(verdicts({}));
    await siblingsServable([row(1), row(2), row(3)], isSignal, read);
    expect(read.mock.calls).toEqual([[[1, 2, 3]]]);
  });

  it('refuses a url with as many other rows as it reads', async () => {
    const rows = Array.from({ length: URL_SIBLING_CAP }, (_, id) => row(id));
    expect(await siblingsServable(rows, isSignal, verdicts({}))).toBe(false);
    expect(await siblingsServable(rows.slice(1), isSignal, verdicts({}))).toBe(true);
  });
});
