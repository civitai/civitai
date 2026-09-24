import { create } from 'zustand';

export type PushSupport =
  | 'supported'
  | 'needs-standalone' // iOS Safari tab: PushManager only exists after Add to Home Screen
  | 'unsupported';

type PushSubscriptionStore = {
  support: PushSupport;
  permission: NotificationPermission | null;
  /** Whether THIS browser currently holds a PushManager subscription object. */
  subscribed: boolean;
  /** This browser's subscription endpoint — matches its PushSubscription row. */
  currentEndpoint: string | null;
  busy: boolean;
  set: (patch: Partial<Omit<PushSubscriptionStore, 'set'>>) => void;
};

/**
 * Browser-side push state, held in ONE module-level store rather than per-hook `useState`.
 *
 * `usePushSubscription` is mounted independently by `PushDeviceToggle` and `PushDeviceList` (both
 * settings surfaces render the pair), and with per-instance state those copies diverge: revoking
 * "this device" from the list runs `disable()` against the list's own copy, leaving the toggle
 * rendering `checked` from a `subscribed: true` that is no longer true — a switch that says on for
 * a device that has just been revoked, until something remounts it. The permission/registration
 * facts are per-BROWSER, not per-component, so they belong in one place.
 *
 * Only browser-derived state lives here. Whether the SERVER still holds this endpoint's row stays
 * in react-query (`getPushSubscriptions`), which already shares its cache across instances.
 *
 * SSR-safe by construction, and it has to stay that way: this module is a singleton shared by every
 * request the node process serves, so a write reachable during server render would leak one user's
 * push state into another's HTML. Every mutation below is reached only from a `useEffect` or a user
 * callback in `usePushSubscription` — both browser-only — so a server render always reads these
 * initial values, which is exactly what the per-instance `useState` defaults produced before.
 * Do not seed this store from server data.
 */
export const usePushSubscriptionStore = create<PushSubscriptionStore>()((set) => ({
  support: 'unsupported',
  permission: null,
  subscribed: false,
  currentEndpoint: null,
  busy: false,
  set: (patch) => set(patch),
}));
