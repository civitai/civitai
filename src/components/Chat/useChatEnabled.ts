import { useFeatureFlags, useFeatureFlagsReady } from '~/providers/FeatureFlagsProvider';

/**
 * Whether chat UI should render for the current user.
 *
 * The chat enable/disable toggle lives in `features.chat` (from
 * `user.getFeatureFlags`). That overlay is now SSR-seeded in _app for logged-in
 * users, so `features.chat` is correct from frame 0 and `useFeatureFlagsReady()`
 * is true immediately — no flash. On the rare no-seed path (failed SSR snapshot,
 * or a session that resolves client-side) `chat` defaults to the anon SSR value
 * until the per-user overlay resolves, which would flash the chat icon in then
 * back out; gating on `useFeatureFlagsReady()` — true once that overlay has
 * settled (or there is no logged-in user) — defers render until the user's chat
 * setting is known.
 *
 * Previously this forced a `user.getSettings` refetch (`staleTime: 0`) purely to
 * observe when the batched flags fetch landed; reading readiness directly avoids
 * that per-mount round-trip.
 */
export function useChatEnabled() {
  const features = useFeatureFlags();
  const ready = useFeatureFlagsReady();
  return ready && features.chat;
}
