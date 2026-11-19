import { describe, expect, it } from 'vitest';
import { orderRemixMenuApps, recentRemixAppSlugs } from '~/shared/remix-apps/menu';

const apps = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((slug) => ({ slug }));
const slugsOf = (apps: { slug: string }[]) => apps.map((app) => app.slug);

describe('orderRemixMenuApps', () => {
  it('puts pins first in pin order, tops up with recents, then the registry order', () => {
    const result = orderRemixMenuApps({ apps, pinned: ['f', 'c'], recent: ['g', 'c', 'a'] });
    expect(slugsOf(result)).toEqual(['f', 'c', 'g', 'a', 'b']);
  });

  it('skips a pinned or recent slug this viewer cannot run here, without failing the rest', () => {
    const result = orderRemixMenuApps({
      apps: apps.slice(0, 3),
      pinned: ['gone', 'b'],
      recent: ['disabled', 'c'],
    });
    expect(slugsOf(result)).toEqual(['b', 'c', 'a']);
  });
});

describe('recentRemixAppSlugs', () => {
  it('reads each app once, newest first, and ignores workflows that name none', () => {
    const workflows = [
      { tags: ['remix-app', 'remix-app:b', 'remix-run:r1'] },
      { tags: ['gen'] },
      { tags: null },
      { tags: ['remix-app', 'remix-app:a'] },
      { tags: ['remix-app', 'remix-app:b'] },
    ];
    expect(recentRemixAppSlugs(workflows)).toEqual(['b', 'a']);
  });
});
