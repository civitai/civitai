import { create } from 'zustand';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';

export type HubSourceKeyed = { type: UserHubSourceType; targetId: number };

export const hubSourceKey = (source: HubSourceKeyed) => `${source.type}:${source.targetId}`;

/**
 * What a viewer changed about someone else's hub. Deliberately in memory and not
 * persisted: on a hub you do not own, a source toggle and a content level are a
 * view of it, and the closing condition for both is that a reload leaves the
 * owner's stored settings alone (subtasks 868kwp5fn, 868kwp5gt).
 */
type HubSessionState = {
  excludedSources: Record<number, HubSourceKeyed[]>;
  browsingLevel: Record<number, number>;
  toggleSource: (hubId: number, source: HubSourceKeyed, enabled: boolean) => void;
  setBrowsingLevel: (hubId: number, level: number) => void;
};

const useHubSessionStore = create<HubSessionState>((set) => ({
  excludedSources: {},
  browsingLevel: {},
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
}));

const NO_EXCLUSIONS: HubSourceKeyed[] = [];

// A stable empty array, because this feeds a react-query key: a fresh `[]` every
// render is a new key every render, which refetches the feed forever.
export const useHubExcludedSources = (hubId: number) =>
  useHubSessionStore((state) => state.excludedSources[hubId] ?? NO_EXCLUSIONS);

export const useHubSessionBrowsingLevel = (hubId: number) =>
  useHubSessionStore((state) => state.browsingLevel[hubId]);

export const useToggleHubSessionSource = () => useHubSessionStore((state) => state.toggleSource);

export const useSetHubSessionBrowsingLevel = () =>
  useHubSessionStore((state) => state.setBrowsingLevel);
