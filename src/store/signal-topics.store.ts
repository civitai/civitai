import { create } from 'zustand';

interface SignalTopicsState {
  registeredTopics: string[];
  addTopic: (topic: string) => void;
  removeTopic: (topic: string) => void;
}

/**
 * Tracks the set of currently-subscribed signal topics. Lives outside the
 * `SignalsProvider` React tree so register/release events don't re-render
 * every consumer of `SignalContext` — the high-volume `MetricsLive` cards
 * read `registerTopic`/`releaseTopic` from context but don't care about
 * the topic list itself.
 */
export const useSignalTopicsStore = create<SignalTopicsState>((set) => ({
  registeredTopics: [],
  addTopic: (topic) =>
    set((state) =>
      state.registeredTopics.includes(topic)
        ? state
        : { registeredTopics: [...state.registeredTopics, topic] }
    ),
  removeTopic: (topic) =>
    set((state) =>
      state.registeredTopics.includes(topic)
        ? { registeredTopics: state.registeredTopics.filter((t) => t !== topic) }
        : state
    ),
}));

/** Reactive selector — components re-render only when this topic's registration status changes. */
export const useIsTopicRegistered = (topic: string) =>
  useSignalTopicsStore((s) => s.registeredTopics.includes(topic));
