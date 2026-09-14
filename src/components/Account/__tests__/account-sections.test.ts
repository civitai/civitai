import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  accountSections,
  getAccountSectionHref,
  getOverviewHref,
  legacyAnchorSections,
  resolveAccountSection,
  resolveLegacyAnchor,
  searchAccountSections,
} from '~/components/Account/account-sections';

describe('account section registry', () => {
  it('has unique ids and paths', () => {
    const ids = accountSections.map((section) => section.id);
    const paths = accountSections.map((section) => section.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('resolves the index to Overview and unknown slugs to undefined', () => {
    expect(resolveAccountSection(undefined)?.id).toBe('overview');
    expect(resolveAccountSection('')?.id).toBe('overview');
    expect(resolveAccountSection('billing')?.id).toBe('billing');
    expect(resolveAccountSection('not-a-section')).toBeUndefined();
  });

  // Deleting the alias resolves `/user/account/overview` to a 404, not to the overview.
  it('resolves the overview alias, and it is not the index href', () => {
    expect(resolveAccountSection('overview')?.id).toBe('overview');
    expect(getOverviewHref()).toBe('/user/account/overview');
    expect(getAccountSectionHref(accountSections[0])).toBe('/user/account');
  });

  it('builds hrefs without a trailing slash on the index', () => {
    expect(getAccountSectionHref(accountSections[0])).toBe('/user/account');
    expect(getAccountSectionHref(accountSections[1])).toBe('/user/account/profile');
  });

  it('matches on keywords, not just labels', () => {
    // "tipalti" appears in no section label; without keyword search this returns nothing.
    expect(searchAccountSections('tipalti').map((s) => s.id)).toEqual(['billing']);
    expect(searchAccountSections('hidden tags').map((s) => s.id)).toEqual(['content']);
    expect(searchAccountSections('zzzz')).toEqual([]);
  });
});

describe('legacy anchor redirects', () => {
  const expected: Record<string, string> = {
    '#payments': 'billing',
    '#payment-methods': 'billing',
    '#manage-subscription': 'billing',
    '#strikes': 'profile',
    '#creator-score': 'profile',
    '#accounts': 'security',
    '#api-keys': 'security',
    '#notification-settings': 'notifications',
  };

  it.each(Object.entries(expected))('%s resolves to the %s pane', (hash, sectionId) => {
    expect(resolveLegacyAnchor(hash)?.id).toBe(sectionId);
  });

  it('tolerates a missing # and mixed case', () => {
    expect(resolveLegacyAnchor('payments')?.id).toBe('billing');
    expect(resolveLegacyAnchor('#Payment-Methods')?.id).toBe('billing');
  });

  it('returns undefined for an unmapped anchor', () => {
    expect(resolveLegacyAnchor('#nope')).toBeUndefined();
    expect(resolveLegacyAnchor('')).toBeUndefined();
  });

  it('points every mapped anchor at a section that exists', () => {
    for (const sectionId of Object.values(legacyAnchorSections)) {
      expect(accountSections.some((section) => section.id === sectionId)).toBe(true);
    }
  });

  /**
   * The map is only load-bearing while it covers what the codebase actually emits. Stripe and
   * Tipalti `return_url`s and already-delivered strike emails cannot be edited after the fact, so
   * an anchor added here without a map entry lands on Overview and the user never reaches the
   * thing the link promised.
   */
  it('covers every /user/account#anchor emitted anywhere in src', () => {
    const srcDir = path.resolve(__dirname, '../../..');
    const found = new Set<string>();

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        // Tests and mocks describe links rather than emit them.
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.(test|spec)\.tsx?$/.test(entry.name) || full.includes('__tests__')) continue;
        const contents = fs.readFileSync(full, 'utf8');
        for (const match of contents.matchAll(/\/user\/account(?:\?[^'"`#\s]*)?#([a-zA-Z-]+)/g)) {
          found.add(match[1].toLowerCase());
        }
      }
    };
    walk(srcDir);

    expect(found.size).toBeGreaterThan(0);
    const uncovered = [...found].filter((anchor) => !(anchor in legacyAnchorSections));
    expect(uncovered).toEqual([]);
  });
});
