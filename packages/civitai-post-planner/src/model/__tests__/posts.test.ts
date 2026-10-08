import { describe, expect, it } from 'vitest';
import type { PlannerPost, PlannerPostDetail } from '../../host';
import {
  applyOverrides,
  capColor,
  countScheduled,
  countScheduledOn,
  drawerPost,
  hasMature,
  isScheduled,
  modelFilterOptions,
  neighbours,
  scopeOf,
  visiblePosts,
} from '../posts';

const now = new Date(2026, 9, 8, 12);
const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

const post = (iso: string, id = 1, extra: Partial<PlannerPost> = {}): PlannerPost => ({
  id,
  title: null,
  publishedAt: iso,
  modelVersionId: null,
  nsfwLevel: 1,
  imageCount: 1,
  cover: null,
  release: null,
  ...extra,
});

const release = (scope: 'model' | 'version' = 'version') => ({
  scope,
  modelName: 'Model',
  versionName: 'v1',
});

describe('isScheduled / scopeOf', () => {
  it('is scheduled strictly after now', () => {
    expect(isScheduled(post(at(8, 13)), now)).toBe(true);
    expect(isScheduled(post(now.toISOString()), now)).toBe(false);
    expect(isScheduled(post(at(8, 11)), now)).toBe(false);
  });

  it('scopes a release post by its release and a plain post as post', () => {
    expect(scopeOf(post(at(9, 9)))).toBe('post');
    expect(scopeOf(post(at(9, 9), 1, { release: release('model') }))).toBe('model');
  });
});

describe('applyOverrides', () => {
  it('replaces the date of an overridden post and leaves the rest untouched', () => {
    const posts = [post(at(9, 9), 1), post(at(10, 9), 2)];
    const moved = applyOverrides(posts, new Map([[1, { from: at(9, 9), to: at(12, 9) }]]));
    expect(moved[0].publishedAt).toBe(at(12, 9));
    expect(moved[1]).toBe(posts[1]);
  });
});

describe('visiblePosts', () => {
  const posts = [
    post(at(9, 9), 1),
    post(at(7, 9), 2),
    post(at(10, 9), 3, { release: release() }),
    post(at(11, 9), 4, { modelVersionId: 7 }),
  ];

  it('defaults to scheduled, non-published, with releases', () => {
    const ids = visiblePosts(posts, { scheduled: true, published: false, releases: true }, now);
    expect(ids.map((p) => p.id)).toEqual([1, 3, 4]);
  });

  it('can show only published posts and drop releases', () => {
    expect(
      visiblePosts(posts, { scheduled: false, published: true, releases: true }, now).map(
        (p) => p.id
      )
    ).toEqual([2]);
    expect(
      visiblePosts(posts, { scheduled: true, published: true, releases: false }, now).map(
        (p) => p.id
      )
    ).toEqual([1, 2, 4]);
  });

  it('narrows to one model version when asked', () => {
    expect(
      visiblePosts(posts, { scheduled: true, published: true, releases: true }, now, 7).map(
        (p) => p.id
      )
    ).toEqual([4]);
  });
});

describe('countScheduled / countScheduledOn', () => {
  const posts = [post(at(9, 9), 1), post(at(9, 20), 2), post(at(7, 9), 3), post(at(10, 9), 4)];

  it('counts only future posts', () => {
    expect(countScheduled(posts, now)).toBe(3);
  });

  it('counts future posts on one local day', () => {
    expect(countScheduledOn(posts, '2026-10-09', now)).toBe(2);
    expect(countScheduledOn(posts, '2026-10-07', now)).toBe(0);
  });
});

describe('neighbours', () => {
  const posts = [post(at(10, 9), 3), post(at(9, 9), 2), post(at(11, 9), 4)];

  it('walks in publish order regardless of input order', () => {
    expect(neighbours(posts, 3)).toMatchObject({ prev: { id: 2 }, next: { id: 4 } });
    expect(neighbours(posts, 2)).toMatchObject({ prev: null, next: { id: 3 } });
    expect(neighbours(posts, 4)).toMatchObject({ prev: { id: 3 }, next: null });
  });

  it('has no neighbours for a post outside the list', () => {
    expect(neighbours(posts, 99)).toEqual({ prev: null, next: null });
  });
});

describe('modelFilterOptions', () => {
  it('names a release version after its model and a bare version by its id', () => {
    const posts = [
      post(at(9, 9), 1, { modelVersionId: 5 }),
      post(at(9, 9), 2, { modelVersionId: 5, release: release() }),
      post(at(9, 9), 3, { modelVersionId: 6 }),
      post(at(9, 9), 4),
    ];
    expect(modelFilterOptions(posts)).toEqual([
      { value: '5', label: 'Model · v1' },
      { value: '6', label: 'Version #6' },
    ]);
  });
});

describe('hasMature / capColor', () => {
  it('detects anything above PG', () => {
    expect(hasMature([post(at(9, 9), 1, { nsfwLevel: 1 })])).toBe(false);
    expect(
      hasMature([post(at(9, 9), 1, { nsfwLevel: 1 }), post(at(9, 9), 2, { nsfwLevel: 4 })])
    ).toBe(true);
  });

  it('warns at the cap, errors over it and is silent without one', () => {
    expect(capColor(2, 3)).toBe('');
    expect(capColor(3, 3)).toBe('warning');
    expect(capColor(4, 3)).toBe('error');
    expect(capColor(4, 0)).toBe('');
  });
});

describe('drawerPost', () => {
  const list = post(at(12, 9), 1, { release: release('model') });
  const detail: PlannerPostDetail = {
    ...post(at(9, 9), 1),
    description: 'hi',
    media: [],
    model: null,
    resources: [],
    tools: [],
    techniques: [],
    tags: [],
    stats: null,
  };

  it('takes the detail but keeps the list date and release', () => {
    expect(drawerPost(list, detail)).toMatchObject({
      description: 'hi',
      publishedAt: at(12, 9),
      release: { scope: 'model' },
    });
  });

  it('falls back to whichever side is present', () => {
    expect(drawerPost(list, null)).toBe(list);
    expect(drawerPost(null, detail)).toBe(detail);
    expect(drawerPost(null, null)).toBeNull();
  });
});
