import { create } from 'zustand';
import type { HubFeedFilters } from '~/server/schema/user-hub.schema';
import type { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * What a viewer changed about someone else's hub. Deliberately in memory and not
 * persisted: a content level and a sort are a view of someone's hub, and the closing
 * condition is that a reload leaves the owner's stored settings alone (subtasks
 * 868kwp5fn, 868kwp5gt).
 *
 * A viewer cannot switch the owner's SOURCES off — Justin's call, 2026-09-17: you see
 * what the owner curated, and duplicating the hub is how you get a different one.
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
  setBrowsingLevel: (hubId: number, level: number) => void;
  setIncludePG13: (hubId: number, include: boolean) => void;
  setFeedFilters: (hubId: number, next: HubSessionFeedFilters) => void;
};

export const hubSessionStore = create<HubSessionState>((set) => ({
  browsingLevel: {},
  includePG13: {},
  feedFilters: {},
  setBrowsingLevel: (hubId, level) =>
    set((state) => ({ browsingLevel: { ...state.browsingLevel, [hubId]: level } })),
  setIncludePG13: (hubId, include) =>
    set((state) => ({ includePG13: { ...state.includePG13, [hubId]: include } })),
  setFeedFilters: (hubId, next) =>
    set((state) => ({
      feedFilters: { ...state.feedFilters, [hubId]: { ...state.feedFilters[hubId], ...next } },
    })),
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
