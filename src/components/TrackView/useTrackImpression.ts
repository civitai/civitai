import { useContext, useEffect, useRef } from 'react';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { recordImpression } from '~/components/TrackView/impressionBuffer';
import type { ImpressionEntityType } from '~/server/schema/track.schema';

export type ImpressionTarget = { entityType: ImpressionEntityType; entityId: number };

// What counts as an impression. Both halves are load-bearing:
//
// - HALF the card visible, so a sliver clipped at the edge of the viewport is not
//   an impression.
// - for a CONTINUOUS second, so scrolling past at speed is not one either.
//
// Anything looser produces a number nobody can defend — "was on screen for one
// frame during a flick scroll" is not reach. Changing either constant changes
// what every historical impression number meant, so they are stated in the PR and
// in the Creator Studio label rather than left implicit here.
const VISIBLE_FRACTION = 0.5;
const DWELL_MS = 1000;

// The shared feed observer (IntersectionObserverProvider) is deliberately eager —
// `rootMargin: '100% 0px'` — because it drives rendering and wants a full viewport
// of warning. Reusing it here would count a screenful of cards ABOVE and BELOW
// the viewport as seen, in both scroll directions. Impressions need their own
// observer with no margin.
type ElementState = { targets: ImpressionTarget[]; timer: ReturnType<typeof setTimeout> | null };

type Registry = {
  observer: IntersectionObserver;
  elements: Map<Element, ElementState>;
  intersecting: Set<Element>;
};

// One observer per scroll root shared by every card under it. A feed mounts
// hundreds of cards, and an observer each would be hundreds of observers.
const registries = new Map<Element | null, Registry>();
let visibilityBound = false;

function armDwell(registry: Registry, element: Element, state: ElementState) {
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    for (const target of state.targets) recordImpression(target.entityType, target.entityId);
    // Recorded — stop watching. The session-level dedupe in the buffer would drop
    // a repeat anyway; this just avoids re-arming the timer on every scroll.
    registry.observer.unobserve(element);
    registry.elements.delete(element);
    registry.intersecting.delete(element);
  }, DWELL_MS);
}

function disarmDwell(state: ElementState) {
  if (state.timer === null) return;
  clearTimeout(state.timer);
  state.timer = null;
}

// A hidden tab keeps its IntersectionObserver entries intersecting — nothing
// scrolls, so nothing fires — which means a dwell timer armed just before the tab
// was backgrounded would mature while nobody is looking. Timers are dropped on
// hide and re-armed on return, so the dwell always describes a second of visible
// time rather than a second of elapsed time.
function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    for (const registry of registries.values()) {
      for (const element of registry.intersecting) {
        const state = registry.elements.get(element);
        if (!state) continue;
        if (hidden) disarmDwell(state);
        else armDwell(registry, element, state);
      }
    }
  });
}

function getRegistry(root: Element | null): Registry {
  const existing = registries.get(root);
  if (existing) return existing;

  const elements = new Map<Element, ElementState>();
  const intersecting = new Set<Element>();
  const registry: Registry = {
    observer: null as unknown as IntersectionObserver,
    elements,
    intersecting,
  };

  registry.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const state = elements.get(entry.target);
        if (!state) continue;
        if (entry.isIntersecting) {
          intersecting.add(entry.target);
          if (document.visibilityState === 'visible') armDwell(registry, entry.target, state);
        } else {
          intersecting.delete(entry.target);
          disarmDwell(state);
        }
      }
    },
    { root, threshold: VISIBLE_FRACTION }
  );

  registries.set(root, registry);
  return registry;
}

/**
 * Report that this element's entities were seen, once it has been half visible
 * for a continuous second.
 *
 * Takes a LIST because one card can present more than one entity: a model card
 * shows a model AND whichever cover image the viewer's browsing level selected,
 * and both were genuinely seen. Recording only the card's own entity would leave
 * the image — the thing that actually drew the eye, and whose creator wants the
 * number — invisible.
 */
export function useTrackImpression<T extends HTMLElement = HTMLDivElement>(
  targets: ImpressionTarget[] | undefined
) {
  const ref = useRef<T>(null);
  const features = useFeatureFlags();
  const enabled = features.feedImpressions && !!targets?.length;

  // Identity of the entities, not of the array — callers rebuild the array every
  // render, and re-observing on that would be constant churn. This is the effect's
  // real dependency; `targets` is read inside it and deliberately not a dep.
  const key = targets?.map((t) => `${t.entityType}:${t.entityId}`).join(',') ?? '';

  // 🔴 `useContext(ScrollAreaContext)`, NOT `useScrollAreaRef()`. That hook looks
  // like a plain context read but unconditionally registers a `scroll` listener on
  // the container — a no-op one when no `onScroll` is passed, yet still a real
  // listener invoked on every scroll event. It had ~20 call sites, all singletons;
  // routing every card through it would add one per card. Worse, a hook cannot be
  // conditional, so that cost would be paid with the feature flag OFF, breaking
  // the promise that the kill switch restores the pre-feature client cost.
  // Only the ref is needed here.
  //
  // Resolved once per effect run and reused by the cleanup: reading `.current`
  // again at teardown can yield a different element than the registry was keyed
  // by, which would leak the entry it was meant to remove.
  const root = useContext(ScrollAreaContext)?.ref.current ?? null;

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;

    bindVisibility();
    const registry = getRegistry(root);
    // Read here rather than through a ref written during render: a render that
    // React abandons would leave such a ref pointing at a value that was never
    // committed. `key` changes whenever these ids do, so the effect re-runs.
    const state: ElementState = { targets: targets ?? [], timer: null };
    registry.elements.set(element, state);
    registry.observer.observe(element);

    return () => {
      disarmDwell(state);
      registry.observer.unobserve(element);
      registry.elements.delete(element);
      registry.intersecting.delete(element);

      // Drop the whole registry once its last card goes. Without this, every
      // scroll root a single-page session ever mounted stays in `registries`
      // for the tab's lifetime — each holding a live observer and a strong
      // reference to a detached root element, and each walked again on every
      // tab switch by bindVisibility.
      if (registry.elements.size === 0) {
        registry.observer.disconnect();
        registries.delete(root);
      }
    };
    // `targets` is deliberately absent: `key` is derived from the entity ids
    // inside it and changes exactly when they do, while the array's identity
    // changes on every render of every card. Depending on the array would
    // re-observe hundreds of cards per render for no change in meaning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, root]);

  return ref;
}
