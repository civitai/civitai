import { create } from 'zustand';
import { hubSourceKey } from '~/server/schema/user-hub.schema';
import type { HubFeedFilters, HubSourceExclusionInput } from '~/server/schema/user-hub.schema';
import type { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';

export type HubSourceKeyed = HubSourceExclusionInput;

/**
 * What a viewer changed about someone else's hub. Deliberately in memory and not
 * persisted: on a hub you do not own, a source toggle and a content level are a
 * view of it, and the closing condition for both is that a reload leaves the
 * owner's stored settings alone (subtasks 868kwp5fn, 868kwp5gt).
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
  excludedSources: Record<number, HubSourceKeyed[]>;
  browsingLevel: Record<number, number>;
  includePG13: Record<number, boolean>;
  feedFilters: Record<number, HubSessionFeedFilters>;
  toggleSource: (hubId: number, source: HubSourceKeyed, enabled: boolean) => void;
  setBrowsingLevel: (hubId: number, level: number) => void;
  setIncludePG13: (hubId: number, include: boolean) => void;
  setFeedFilters: (hubId: number, next: HubSessionFeedFilters) => void;
};

export const hubSessionStore = create<HubSessionState>((set) => ({
  excludedSources: {},
  browsingLevel: {},
  includePG13: {},
  feedFilters: {},
  toggleSource: (hubId, source, enabled) =>
    set((state) => {
      const current = state.excludedSources[hubId] ?? [];
      const without = current.filter((s) => hubSourceKey(s) !== hubSourceKey(source));
      return {
        excludedSources: {
          ...state.excludedSources,
          [hubId]: enabled
            ? without
            : [...without, { type: source.type, targetId: source.targetId }],
        },
      };
    }),
  setBrowsingLevel: (hubId, level) =>
    set((state) => ({ browsingLevel: { ...state.browsingLevel, [hubId]: level } })),
  setIncludePG13: (hubId, include) =>
    set((state) => ({ includePG13: { ...state.includePG13, [hubId]: include } })),
  setFeedFilters: (hubId, next) =>
    set((state) => ({
      feedFilters: { ...state.feedFilters, [hubId]: { ...state.feedFilters[hubId], ...next } },
    })),
}));

const NO_EXCLUSIONS: HubSourceKeyed[] = [];

// A stable empty array, because this feeds a react-query key: a fresh `[]` every
// render is a new key every render, which refetches the feed forever. Written as a
// named selector so that property is assertable without rendering anything.
export const selectHubExcludedSources = (hubId: number) => (state: HubSessionState) =>
  state.excludedSources[hubId] ?? NO_EXCLUSIONS;

export const useHubExcludedSources = (hubId: number) =>
  hubSessionStore(selectHubExcludedSources(hubId));

export const useHubSessionBrowsingLevel = (hubId: number) =>
  hubSessionStore((state) => state.browsingLevel[hubId]);

export const useToggleHubSessionSource = () => hubSessionStore((state) => state.toggleSource);

export const useSetHubSessionBrowsingLevel = () =>
  hubSessionStore((state) => state.setBrowsingLevel);

// The green-domain half of the same rule. The owner's stored `includePG13` is a
// control the OWNER opted into; handing it to a viewer lifts that viewer's own
// domain cap on the owner's say-so, so a hub you do not own reads this instead.
export const useHubSessionIncludePG13 = (hubId: number) =>
  hubSessionStore((state) => state.includePG13[hubId] ?? false);

export const useSetHubSessionIncludePG13 = () => hubSessionStore((state) => state.setIncludePG13);

// Same stable-identity rule as the exclusions: this reaches a react-query key.
const NO_FEED_FILTERS: HubSessionFeedFilters = {};

export const selectHubSessionFeedFilters = (hubId: number) => (state: HubSessionState) =>
  state.feedFilters[hubId] ?? NO_FEED_FILTERS;

export const useHubSessionFeedFilters = (hubId: number) =>
  hubSessionStore(selectHubSessionFeedFilters(hubId));

export const useSetHubSessionFeedFilters = () => hubSessionStore((state) => state.setFeedFilters);
