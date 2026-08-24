// @vitest-environment happy-dom
import fs from 'fs';
import path from 'path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HiddenPreferences from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type * as TrackUtils from '~/components/TrackView/track.utils';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: '/images',
  query: {} as Record<string, unknown>,
  tags: [] as { id: number; name: string; nsfwLevel: number }[],
  hiddenTagIds: [] as number[],
  loadingPreferences: false,
  maxNsfwLevel: 1,
  trackAction: vi.fn(() => Promise.resolve()),
  // Sparse, exactly as FeatureAccess is: an off flag is ABSENT, so it reads `undefined`.
  // Driving the off case with `false` would test a state production never produces.
  feedTagBar: true as boolean | undefined,
  getFeedTagBar: vi.fn(),
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: mocks.query, pathname: mocks.pathname, replace: mocks.replace }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    tag: {
      getFeedTagBar: {
        // Records the options so a test can assert the request is SKIPPED when the flag
        // is off. It returns the tags either way, which is deliberately unlike
        // react-query (a disabled query yields no data) — a gate that only hid the
        // markup would still be caught here rather than looking like a skipped fetch.
        useQuery: (input: unknown, options?: { enabled?: boolean }) => {
          mocks.getFeedTagBar(input, options);
          return { data: mocks.tags };
        },
      },
    },
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({ feedTagBar: mocks.feedTagBar }),
}));

// Stands in for the real hidden-preferences provider, which needs a session + query
// client. `hiddenTagIds` drives it so the bar's use of it is observable rather than
// assumed — a bar that ignored the hook would keep rendering a hidden chip.
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferences>()),
  useApplyHiddenPreferences: ({ data }: { data?: { id: number; nsfwLevel?: number }[] }) => ({
    // Models the two arms the bar depends on: the viewer's own hidden tags, and the
    // browsing-level cut the real hook makes on `tag.nsfwLevel`. The level arm is why
    // `getFeedTagBarTags` ships that field at all, so a stand-in that ignored it would
    // leave the reason the column is selected untested.
    items: (data ?? []).filter(
      (x) => !mocks.hiddenTagIds.includes(x.id) && (x.nsfwLevel ?? 1) <= mocks.maxNsfwLevel
    ),
    loadingPreferences: mocks.loadingPreferences,
  }),
}));

vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  useTrackEvent: () => ({
    trackAction: mocks.trackAction,
    trackSearch: vi.fn(),
    trackShare: vi.fn(),
  }),
}));

import { MantineProvider } from '@mantine/core';

import { ImageFeedTagBar } from '~/components/Image/Filters/ImageFeedTagBar';
import { FEED_TAG_BAR_TAG_NAMES } from '~/server/common/feed-tag-bar.constants';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(feed: 'images' | 'videos' = 'images') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light' },
        createElement(ImageFeedTagBar, { feed })
      )
    );
  });
  return container;
}

function buttonLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!button) throw new Error(`no button labelled ${label}; found ${buttonLabels(container)}`);
  act(() => {
    button.click();
  });
}

function reservedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('div')).filter((el) =>
    el.className.includes('min-h-[26px]')
  );
}

function lastReplacedQuery() {
  const [target] = mocks.replace.mock.calls[mocks.replace.mock.calls.length - 1];
  return (target as { query: Record<string, unknown> }).query;
}

describe('ImageFeedTagBar', () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.trackAction.mockClear();
    mocks.getFeedTagBar.mockClear();
    mocks.feedTagBar = true;
    mocks.pathname = '/images';
    mocks.query = {};
    mocks.hiddenTagIds = [];
    mocks.maxNsfwLevel = 1;
    mocks.loadingPreferences = false;
    mocks.tags = [
      { id: 4, name: 'anime', nsfwLevel: 1 },
      { id: 5248, name: 'realistic', nsfwLevel: 1 },
    ];
  });

  it('renders the All chip plus every tag, in the order the server sent them', () => {
    const container = render();
    expect(buttonLabels(container)).toEqual(['All', 'anime', 'realistic']);
  });

  // Gated so the bar can be switched off without a deploy, after its click-through came
  // in under the floor it shipped on (868kv1b9m). `feedTagBar` fails OPEN, so the case
  // that needs pinning is that OFF actually removes it.
  it('renders nothing when the feedTagBar flag is off', () => {
    mocks.feedTagBar = undefined;
    const container = render();

    expect(buttonLabels(container)).toEqual([]);
    // The reserved row too, not just the chips: the bar holds height while its tags load,
    // so a gate that only emptied the chip list would still push the feed down by 26px.
    expect(reservedRows(container)).toHaveLength(0);
  });

  it('does not request the chip list when the flag is off, and does when it is on', () => {
    // `undefined`, not `false` — see the note on `mocks.feedTagBar`.
    mocks.feedTagBar = undefined;
    render();
    // Strictly `false`, not merely falsy: react-query reads `enabled: undefined` as
    // ENABLED, so a gate that forwarded the sparse flag straight through would fetch.
    // Zero calls satisfies this too, so hoisting the gate above the hook stays green.
    for (const [, options] of mocks.getFeedTagBar.mock.calls) {
      expect(options?.enabled).toBe(false);
    }

    mocks.getFeedTagBar.mockClear();
    mocks.feedTagBar = true;
    render();
    // The control. Without it the arm above passes for a bar that can never fetch.
    expect(mocks.getFeedTagBar).toHaveBeenCalledTimes(1);
    expect(mocks.getFeedTagBar).toHaveBeenCalledWith(undefined, { enabled: true });
  });

  it('writes ?tags=<id> on select, preserving the rest of the query', () => {
    mocks.query = { sort: 'Newest' };
    const container = render();

    clickButton(container, 'anime');

    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(lastReplacedQuery()).toEqual({ sort: 'Newest', tags: [4] });
  });

  it('replaces rather than stacks when a second chip is chosen', () => {
    mocks.query = { tags: ['4'] };
    const container = render();

    clickButton(container, 'realistic');

    expect(lastReplacedQuery()).toEqual({ tags: [5248] });
  });

  it('toggles the active chip back off', () => {
    mocks.query = { tags: ['4'], sort: 'Newest' };
    const container = render();

    clickButton(container, 'anime');

    expect(lastReplacedQuery()).toEqual({ sort: 'Newest' });
    expect(lastReplacedQuery()).not.toHaveProperty('tags');
  });

  // The reason the All chip is not decoration: ActiveTagFilter is mounted nowhere
  // (868kuq3jk), so before this bar a ?tags= deep link on /images could not be widened
  // by any UI. An id that is not a chip here is exactly that case.
  it('clears a ?tags= deep link whose id is not one of the chips', () => {
    mocks.query = { tags: ['999999'], sort: 'Newest' };
    const container = render();

    expect(buttonLabels(container)).toEqual(['All', 'anime', 'realistic']);

    clickButton(container, 'All');

    expect(lastReplacedQuery()).toEqual({ sort: 'Newest' });
  });

  // Named for what it asserts: the press DOES write, with `tags` absent. `lastReplacedQuery`
  // throws when `replace` was never called, so the explicit call-count assertion goes
  // first — otherwise adding a no-op guard to `handleClear` fails here as an unreadable
  // TypeError rather than a named expectation.
  it('writes an empty query when All is pressed on an already-unfiltered feed', () => {
    const container = render();

    clickButton(container, 'All');

    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(lastReplacedQuery()).toEqual({});
  });

  it('drops a chip the viewer has hidden, keeping the rest', () => {
    mocks.hiddenTagIds = [4];
    const container = render();

    expect(buttonLabels(container)).toEqual(['All', 'realistic']);
  });

  // `getFeedTagBarTags` resolves each chip's nsfwLevel through the parent-tag rollup and
  // ships it precisely so this cut can happen. Without a case, the curated list could
  // gain a chip whose effective level is above the viewer's browsing level and nothing
  // would notice.
  it('drops a chip whose nsfwLevel is above the viewer browsing level', () => {
    mocks.tags = [
      { id: 4, name: 'anime', nsfwLevel: 1 },
      { id: 5140, name: 'furry', nsfwLevel: 16 },
    ];
    const container = render();

    expect(buttonLabels(container)).toEqual(['All', 'anime']);

    // Positive control: the same chip renders for a viewer whose level admits it, so the
    // absence above is the level cut and not a broken fixture.
    mocks.maxNsfwLevel = 16;
    expect(buttonLabels(render())).toEqual(['All', 'anime', 'furry']);
  });

  // The bar writes ONE id, Next serialises that as `?tags=4`, and Next parses a single
  // occurrence back as a bare string — not an array. That round-trip is the one the bar
  // creates for itself every time someone shares or reloads a filtered link, so the
  // array-shaped fixtures elsewhere never exercise it.
  it('reads a single-occurrence ?tags= that arrives as a bare string', () => {
    mocks.query = { tags: '4' };
    const container = render();

    clickButton(container, 'anime');

    // Active, so the press toggles it off — which only happens if '4' parsed to 4.
    expect(lastReplacedQuery()).not.toHaveProperty('tags');
  });

  // The component is mounted on two routes and its whole reason for a `feed` prop is that
  // it is shared. Asserting only `.query` leaves a hardcoded pathname — which would send
  // every /videos chip click to /images — completely invisible. `shallow`/`scroll` ride
  // along here for the same reason: dropping either is silent and user-visible (a full
  // refetch, or the feed jumping to the top on every press).
  it('replaces on the route it is mounted on, shallow and without scrolling', () => {
    mocks.pathname = '/videos';
    const container = render('videos');

    clickButton(container, 'realistic');

    expect(mocks.replace).toHaveBeenCalledWith(
      { pathname: '/videos', query: { tags: [5248] } },
      undefined,
      { shallow: true, scroll: false }
    );
  });

  it('reserves the row height before the tags resolve', () => {
    mocks.tags = [];
    const container = render();

    expect(container.querySelector('button')).toBeNull();
    expect(reservedRows(container)).toHaveLength(1);
  });

  // The chip list is edge-cached and the hidden preferences are a per-user fetch, so the
  // list usually wins the race. Rendering during that window flashes a chip for a tag the
  // viewer has personally hidden.
  it('renders no chips until hidden preferences resolve', () => {
    mocks.loadingPreferences = true;
    const container = render();

    expect(container.querySelector('button')).toBeNull();
    // Positive control: the same data renders chips once preferences have loaded, so this
    // is not passing because the fixture is empty.
    expect(reservedRows(container)).toHaveLength(1);

    mocks.loadingPreferences = false;
    expect(buttonLabels(render())).toEqual(['All', 'anime', 'realistic']);
  });
});

/**
 * The bar ships on the condition that its click-through is measurable — under 10% of
 * feed viewers pressing a chip and it comes back out. Every assertion here is about
 * that number existing at all.
 */
describe('ImageFeedTagBar click-through instrumentation', () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.trackAction.mockClear();
    mocks.getFeedTagBar.mockClear();
    mocks.feedTagBar = true;
    mocks.pathname = '/images';
    mocks.query = {};
    mocks.hiddenTagIds = [];
    mocks.maxNsfwLevel = 1;
    mocks.loadingPreferences = false;
    mocks.tags = [
      { id: 4, name: 'anime', nsfwLevel: 1 },
      { id: 5248, name: 'realistic', nsfwLevel: 1 },
    ];
  });

  it('emits Feed_TagBar_Click naming the chip and the feed on select', () => {
    const container = render('images');

    clickButton(container, 'anime');

    expect(mocks.trackAction).toHaveBeenCalledTimes(1);
    expect(mocks.trackAction).toHaveBeenCalledWith({
      type: 'Feed_TagBar_Click',
      details: { feed: 'images', tag: 'anime', tagId: 4, action: 'select' },
    });
  });

  // Same component on two routes; a hardcoded feed would make the two indistinguishable
  // in ClickHouse and there is no other column that separates them.
  it('carries the videos feed through', () => {
    mocks.pathname = '/videos';
    const container = render('videos');

    clickButton(container, 'realistic');

    expect(mocks.trackAction).toHaveBeenCalledWith({
      type: 'Feed_TagBar_Click',
      details: { feed: 'videos', tag: 'realistic', tagId: 5248, action: 'select' },
    });
  });

  it('records the All chip as a clear, with no tag', () => {
    mocks.query = { tags: ['4'] };
    const container = render();

    clickButton(container, 'All');

    expect(mocks.trackAction).toHaveBeenCalledWith({
      type: 'Feed_TagBar_Click',
      details: { feed: 'images', tag: null, tagId: null, action: 'clear' },
    });
  });

  it('records toggling the active chip off as a clear', () => {
    mocks.query = { tags: ['4'] };
    const container = render();

    clickButton(container, 'anime');

    expect(mocks.trackAction).toHaveBeenCalledWith({
      type: 'Feed_TagBar_Click',
      details: { feed: 'images', tag: null, tagId: null, action: 'clear' },
    });
  });

  it('fires exactly one event per press', () => {
    const container = render();

    clickButton(container, 'anime');
    clickButton(container, 'realistic');

    expect(mocks.trackAction).toHaveBeenCalledTimes(2);
  });
});

/**
 * Rendering the component directly leaves every test above green if the JSX is deleted
 * from the pages — which is how #4141 shipped ActiveTagFilter with a passing suite and
 * no mount point anywhere. This is the only assertion that the bar is on the feeds.
 */
describe('the image and video feeds mount the tag bar', () => {
  it.each([
    ['src/pages/images/index.tsx', 'images'],
    ['src/pages/videos/index.tsx', 'videos'],
  ])('%s renders <ImageFeedTagBar feed="%s" />', (relative, feed) => {
    const repoRoot = path.resolve(__dirname, '../../../../..');
    const source = fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf-8');

    // Commenting the mount out is likelier than deleting it, and leaves the string in
    // place. Block comments are stripped first because that is what an editor's comment
    // command produces over a multi-line selection.
    //
    // ⚠️ Known limits, both of which pass this guard while the bar renders for nobody:
    // `{false && <ImageFeedTagBar … />}`, and — more reachable — `{features.someFlag &&
    // <ImageFeedTagBar … />}`, since a missing Flipt flag reads as false here. Scanning
    // source cannot see either. Worth knowing given this guard exists precisely because
    // #4141 shipped a component mounted nowhere.
    const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const mounted = code
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('<ImageFeedTagBar') && !line.startsWith('//'));

    expect(source).toContain("from '~/components/Image/Filters/ImageFeedTagBar'");
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toContain(`feed="${feed}"`);
  });
});

/**
 * The chip set is curated, and the exclusions are the point of the curation: terms that
 * would rank highly on demand are deliberately absent, and the guard exists so a later
 * edit cannot quietly reintroduce one. A negative assertion alone passes against an
 * empty list, so each is paired with a positive control.
 */
describe('FEED_TAG_BAR_TAG_NAMES', () => {
  const names: readonly string[] = FEED_TAG_BAR_TAG_NAMES;

  it('carries the curated chips', () => {
    expect(names).toContain('anime');
    expect(names).toContain('furry');
    expect(names).toContain('realistic');
    // Low-demand and kept on purpose — the instrumentation is what settles it, so a
    // silent drop would remove the thing being measured. This is what pins it.
    expect(names).toContain('mecha');
    // Exact, not a floor: the set is deliberate, and >= 20 let any two unpinned chips
    // be deleted silently.
    expect(names).toHaveLength(22);
  });

  it.each(['teen', 'school'])('excludes %s', (excluded) => {
    expect(names).toHaveLength(22);
    expect(names).not.toContain(excluded);
  });

  it('holds lowercase, unique names', () => {
    expect(names).toHaveLength(22);
    expect(names).toEqual(names.map((n) => n.trim().toLowerCase()));
    expect(new Set(names).size).toBe(names.length);
  });
});
