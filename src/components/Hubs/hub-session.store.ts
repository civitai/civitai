import { create } from 'zustand';
import type { HubFeedFilters, HubSourceExclusionInput } from '~/server/schema/user-hub.schema';
import { hubSourceKey } from '~/server/schema/user-hub.schema';
import type { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * What a viewer changed about someone else's hub. Deliberately in memory and not
 * persisted: a content level and a sort are a view of someone's hub, and the closing
 * condition is that a reload leaves the owner's stored settings alone (subtasks
 * 868kwp5fn, 868kwp5gt).
 *
 * A viewer CAN switch the owner's sources off, for their own session only — Justin
 * reversed the 2026-09-17 call on 2026-09-21, after using the version without it.
 * Duplicating the hub is not the same affordance: a copy stops tracking the original,
 * so "mute one creator while I read your hub" became "fork it and maintain it".
 */
/**
 * Sort, period, media types and the filter menu, for a viewer of someone else's hub.
 * These only ever narrow the feed in front of them — they are not source controls
 * and not the owner's curation, so they stay visible on a hub you do not own, and
 * land here rather than in an `upsert` the server would refuse.
 */
export type HubSessionFeedFilters = {
  sort?: string;
  period?: MetricTimeframe;
  types?: MediaType[];
  filters?: HubFeedFilters;
};

type HubSessionState = {
  browsingLevel: Record<number, number>;
  includePG13: Record<number, boolean>;
  feedFilters: Record<number, HubSessionFeedFilters>;
  /**
   * The rows themselves rather than keys: this array is handed straight to the feed
   * query, and it is the shape the API takes. Membership is asked with `hubSourceKey`,
   * so a tag and a creator sharing an id stay apart.
   */
  excludedSources: Record<number, HubSourceExclusionInput[]>;
  setBrowsingLevel: (hubId: number, level: number) => void;
  setIncludePG13: (hubId: number, include: boolean) => void;
  setFeedFilters: (hubId: number, next: HubSessionFeedFilters) => void;
  toggleSource: (hubId: number, source: HubSourceExclusionInput) => void;
  clearExcludedSources: (hubId: number) => void;
};

export const hubSessionStore = create<HubSessionState>((set) => ({
  browsingLevel: {},
  includePG13: {},
  feedFilters: {},
  excludedSources: {},
  setBrowsingLevel: (hubId, level) =>
    set((state) => ({ browsingLevel: { ...state.browsingLevel, [hubId]: level } })),
  setIncludePG13: (hubId, include) =>
    set((state) => ({ includePG13: { ...state.includePG13, [hubId]: include } })),
  setFeedFilters: (hubId, next) =>
    set((state) => ({
      feedFilters: { ...state.feedFilters, [hubId]: { ...state.feedFilters[hubId], ...next } },
    })),
  toggleSource: (hubId, source) =>
    set((state) => {
      const key = hubSourceKey(source);
      const held = state.excludedSources[hubId] ?? [];
      const without = held.filter((s) => hubSourceKey(s) !== key);
      return {
        excludedSources: {
          ...state.excludedSources,
          [hubId]: without.length < held.length ? without : [...held, source],
        },
      };
    }),
  clearExcludedSources: (hubId) =>
    set((state) => ({ excludedSources: { ...state.excludedSources, [hubId]: [] } })),
}));

export const useHubSessionBrowsingLevel = (hubId: number) =>
  hubSessionStore((state) => state.browsingLevel[hubId]);

export const useSetHubSessionBrowsingLevel = () =>
  hubSessionStore((state) => state.setBrowsingLevel);

// The green-domain half of the same rule. The owner's stored `includePG13` is a
// control the OWNER opted into; handing it to a viewer lifts that viewer's own
// domain cap on the owner's say-so, so a hub you do not own reads this instead.
export const useHubSessionIncludePG13 = (hubId: number) =>
  hubSessionStore((state) => state.includePG13[hubId] ?? false);

export const useSetHubSessionIncludePG13 = () => hubSessionStore((state) => state.setIncludePG13);

// A stable empty object, because this feeds a react-query key: a fresh one every
// render is a new key every render, which refetches the feed forever.
const NO_FEED_FILTERS: HubSessionFeedFilters = {};

export const selectHubSessionFeedFilters = (hubId: number) => (state: HubSessionState) =>
  state.feedFilters[hubId] ?? NO_FEED_FILTERS;

export const useHubSessionFeedFilters = (hubId: number) =>
  hubSessionStore(selectHubSessionFeedFilters(hubId));

export const useSetHubSessionFeedFilters = () => hubSessionStore((state) => state.setFeedFilters);

// A stable empty array, for the same reason `NO_FEED_FILTERS` is a stable object: this
// feeds a react-query key, and a fresh [] every render refetches the feed forever.
const NO_EXCLUSIONS: HubSourceExclusionInput[] = [];

// Split out the way `selectHubSessionFeedFilters` is, so the stable-empty property is
// reachable from a test without rendering anything.
export const selectHubExcludedSources = (hubId: number) => (state: HubSessionState) =>
  state.excludedSources[hubId] ?? NO_EXCLUSIONS;

export const useHubExcludedSources = (hubId: number) =>
  hubSessionStore(selectHubExcludedSources(hubId));

export const useToggleHubSource = () => hubSessionStore((state) => state.toggleSource);

export const useClearHubExcludedSources = () =>
  hubSessionStore((state) => state.clearExcludedSources);
