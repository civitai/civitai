// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowsingLevelProvider,
  BrowsingModeOverrideCtx,
  useBrowsingLevelContext,
  useBrowsingLevelDebounced,
  useViewerBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * The three things the provider computes its cap FROM. Mocked so the cap's value
 * can be driven, which the hand-built-context cases below deliberately cannot do
 * — supplying the context is what makes the hooks testable and is exactly what
 * hides this computation from them.
 */
const currentUser = { value: null as { id: number } | null };
const canViewNsfw = { value: true };
const settings = { showNsfw: true, browsingLevel: allBrowsingLevelsFlag, blurNsfw: false };

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: canViewNsfw.value }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (state: typeof settings) => unknown) => select(settings),
}));

/**
 * The two hooks, tested where the bug can actually live: in how each one MAPS
 * the provider's three values onto the resolver.
 *
 * 🔴 `resolve-browsing-level.test.ts` pins the resolver, and the resolver was
 * never where anything went wrong. Three mutations survive that file entirely:
 *
 *  1. Delete `forced: forcedBrowsingLevel,` from `useViewerBrowsingLevelDebounced`.
 *     The field is optional, so typecheck stays green; the resolver is untouched,
 *     so its tests stay green. The domain cap silently stops applying and a
 *     logged-in green-domain viewer is served their saved `allBrowsingLevels`.
 *  2. Swap the `override` and `user` keys in `useBrowsingLevelDebounced`. Both
 *     are numbers, so it typechecks, and the viewer's preference then beats every
 *     page override in the app.
 *  3. `export const useViewerBrowsingLevelDebounced = useBrowsingLevelDebounced`
 *     — the "these two look duplicated, consolidate them" tidy-up, which restores
 *     the original bug with every other test still green.
 *
 * The two cases below catch all three. Neither asserts a hook's internals; they
 * assert the answer each hook gives for a context a real page can produce.
 *
 * No fake timers: Mantine's `useDebouncedValue` seeds its state with the value
 * and only starts debouncing after a mounted-ref effect, so the first render
 * already returns the resolved value.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = {
  forcedBrowsingLevel?: number;
  browsingLevelOverride?: number;
  userBrowsingLevel: number;
};

function renderBoth(ctx: Ctx) {
  const result = { page: 0, viewer: 0 };
  const container = document.createElement('div');
  const root = createRoot(container);

  function Probe() {
    result.page = useBrowsingLevelDebounced();
    result.viewer = useViewerBrowsingLevelDebounced();
    return null;
  }

  act(() => {
    root.render(
      createElement(
        BrowsingModeOverrideCtx.Provider,
        { value: { ...ctx, blurLevels: 0 } },
        createElement(Probe)
      )
    );
  });
  act(() => root.unmount());
  return result;
}

describe('browsing level hooks', () => {
  /**
   * 🔴 THE SAFETY CASE. `forcedBrowsingLevel` is a cap nobody may opt out of —
   * the domain ceiling mirroring `applyDomainFeature`, and the minor-safe cap
   * that three galleries write into the same slot. It must beat BOTH the page
   * override and the viewer's saved preference, in BOTH hooks.
   *
   * If this fails, do not adjust the expectation. Someone is being served
   * content past a ceiling that is not theirs to lift.
   */
  it('puts the forced cap above everything, in both hooks', () => {
    const { page, viewer } = renderBoth({
      forcedBrowsingLevel: sfwBrowsingLevelsFlag,
      browsingLevelOverride: NsfwLevel.XXX,
      userBrowsingLevel: allBrowsingLevelsFlag,
    });

    expect(page, 'the page hook must not let an override lift the cap').toBe(sfwBrowsingLevelsFlag);
    expect(viewer, 'the viewer hook must not let a saved preference lift the cap').toBe(
      sfwBrowsingLevelsFlag
    );
  });

  /**
   * The two hooks must DISAGREE here, and that disagreement is the fix.
   *
   * A page override scopes its subtree — the image detail page sets the host
   * image's rating. That is right for the image and wrong for a list of other
   * people's images beside it, which is why the gallery reads the viewer hook.
   * Collapsing the two hooks into one — by aliasing, or by re-adding `override`
   * to the viewer resolution — fails here.
   */
  it('lets a page override scope the page hook, and only the page hook', () => {
    const { page, viewer } = renderBoth({
      browsingLevelOverride: NsfwLevel.PG,
      userBrowsingLevel: allBrowsingLevelsFlag,
    });

    expect(page, 'a page override must still scope the page hook').toBe(NsfwLevel.PG);
    expect(viewer, 'the viewer hook must ignore the page override').toBe(allBrowsingLevelsFlag);
  });
});

/**
 * The provider's own cap computation, which the two cases above cannot see.
 *
 * These render the REAL `BrowsingLevelProvider` so the domain rules and the cap
 * merge are exercised rather than supplied. They mirror `applyDomainFeature` in
 * `src/server/trpc.ts` — anonymous is PG anywhere, a logged-in viewer on a
 * domain that cannot serve mature content is PG+PG-13 — and that mirror is the
 * thing nothing checked before.
 */
function renderUnderProvider(props: { forcedBrowsingLevel?: number; browsingLevel?: number }) {
  const result = { page: 0, viewer: 0 };
  const container = document.createElement('div');
  const root = createRoot(container);

  function Probe() {
    result.page = useBrowsingLevelDebounced();
    result.viewer = useViewerBrowsingLevelDebounced();
    return null;
  }

  act(() => {
    root.render(createElement(BrowsingLevelProvider, props, createElement(Probe)));
  });
  act(() => root.unmount());
  return result;
}

describe('BrowsingLevelProvider caps', () => {
  it('caps a logged-in viewer on a domain that cannot serve mature content', () => {
    currentUser.value = { id: 1 };
    canViewNsfw.value = false;

    const { viewer } = renderUnderProvider({});

    expect(viewer, 'a saved preference must not lift the domain cap').toBe(sfwBrowsingLevelsFlag);
  });

  it('caps an anonymous viewer harder than a logged-in one', () => {
    currentUser.value = null;
    canViewNsfw.value = false;

    expect(renderUnderProvider({}).viewer).toBe(publicBrowsingLevelsFlag);
  });

  /**
   * 🔴 The cap merge. A page passing its own ceiling must not be able to LIFT the
   * domain cap by being nearer — `??` did exactly that, and a collection ceiling
   * of PG+PG-13 over an anonymous domain cap of PG is the live shape.
   */
  it('intersects a page ceiling with the domain cap rather than replacing it', () => {
    currentUser.value = null;
    canViewNsfw.value = false;

    const { viewer } = renderUnderProvider({ forcedBrowsingLevel: sfwBrowsingLevelsFlag });

    expect(viewer, 'a wider page ceiling must not lift the anonymous cap').toBe(
      publicBrowsingLevelsFlag
    );
  });

  it('leaves an uncapped viewer on their own preference', () => {
    currentUser.value = { id: 1 };
    canViewNsfw.value = true;

    expect(renderUnderProvider({}).viewer).toBe(allBrowsingLevelsFlag);
  });

  /**
   * 🔴 A CAP THAT FAILS OPEN. Do not "simplify" the provider by seeding
   * `useState` from the `forcedBrowsingLevel` prop — that is what this pins.
   *
   * `Collection.tsx` keeps the provider mounted across a refetch of the same
   * collection, so a moderator raising the ceiling only ever reaches viewers
   * through a re-render with a new prop. Seeded state freezes the cap at first
   * mount, and every direction of that staleness is toward WIDER: a ceiling set
   * for the first time never applies at all.
   *
   * Read off the context rather than a hook because `useDebouncedValue` holds
   * the previous value for 500ms after a change; the cap itself is not debounced.
   */
  it('applies a ceiling that arrives after mount, and every later change to it', () => {
    currentUser.value = { id: 1 };
    canViewNsfw.value = true;

    const seen: (number | undefined)[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    function Probe() {
      seen.push(useBrowsingLevelContext().forcedBrowsingLevel);
      return null;
    }

    const render = (forcedBrowsingLevel?: number) =>
      act(() => {
        root.render(
          createElement(BrowsingLevelProvider, { forcedBrowsingLevel }, createElement(Probe))
        );
      });

    render(undefined);
    render(sfwBrowsingLevelsFlag);
    render(publicBrowsingLevelsFlag);
    // 🔴 WIDENING, and then clearing. Without these two a cap that only ever
    // ratchets tighter — `intersect(previous, prop)` held in a ref — passes,
    // and a moderator RAISING a ceiling still never reaches a mounted viewer,
    // which is the direction that motivated the whole case.
    render(sfwBrowsingLevelsFlag);
    render(undefined);
    act(() => root.unmount());

    // One equality over the whole sequence rather than per-index reads: `.at(0)`
    // is satisfied by an empty array, and an extra render pass would shift every
    // index and report the wrong assertion.
    expect(seen).toEqual([
      undefined,
      sfwBrowsingLevelsFlag,
      publicBrowsingLevelsFlag,
      sfwBrowsingLevelsFlag,
      undefined,
    ]);
  });

  /**
   * 🔴 The OTHER half of the cap, and the one a rename can drop silently.
   *
   * `PostDetail.tsx:110-115` pushes a contest collection's ceiling into the
   * ancestor provider imperatively rather than as a prop. Nothing else in these
   * files calls the setter, so removing that argument from the intersect list
   * leaves every other case green while the ceiling stops applying.
   */
  it('applies a ceiling set through setForcedBrowsingLevel, intersected with the prop', () => {
    currentUser.value = { id: 1 };
    canViewNsfw.value = true;

    const seen: (number | undefined)[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);

    function Probe() {
      const { forcedBrowsingLevel, setForcedBrowsingLevel } = useBrowsingLevelContext();
      seen.push(forcedBrowsingLevel);
      useEffect(() => {
        setForcedBrowsingLevel?.(publicBrowsingLevelsFlag);
      }, [setForcedBrowsingLevel]);
      return null;
    }

    act(() => {
      root.render(
        createElement(
          BrowsingLevelProvider,
          { forcedBrowsingLevel: sfwBrowsingLevelsFlag },
          createElement(Probe)
        )
      );
    });
    act(() => root.unmount());

    expect(seen.at(0), 'the prop ceiling applies before the setter runs').toBe(
      sfwBrowsingLevelsFlag
    );
    expect(seen.at(-1), 'an imperative ceiling must tighten the prop ceiling').toBe(
      publicBrowsingLevelsFlag
    );
  });

  /**
   * 🔴 A ceiling from an OUTER provider. `Collection.tsx:650` sets one with
   * `BrowsingLevelProviderOptional` and the image-detail providers nested below
   * it, and an inner provider recomputes the domain cap from scratch — so
   * dropping `ctx.forcedBrowsingLevel` from the merge loses the collection's
   * ceiling everywhere it is nested, with nothing else red.
   */
  it('keeps an outer provider ceiling through a nested provider', () => {
    currentUser.value = { id: 1 };
    canViewNsfw.value = true;

    let inner: number | undefined;
    const container = document.createElement('div');
    const root = createRoot(container);

    function Probe() {
      inner = useBrowsingLevelContext().forcedBrowsingLevel;
      return null;
    }

    act(() => {
      root.render(
        createElement(
          BrowsingLevelProvider,
          { forcedBrowsingLevel: sfwBrowsingLevelsFlag },
          createElement(BrowsingLevelProvider, {}, createElement(Probe))
        )
      );
    });
    act(() => root.unmount());

    expect(inner, 'a nested provider must not drop the outer ceiling').toBe(sfwBrowsingLevelsFlag);
  });
});
