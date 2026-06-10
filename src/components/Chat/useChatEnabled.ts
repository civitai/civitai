import { useFeatureFlags, useFeatureFlagsReady } from '~/providers/FeatureFlagsProvider';

/**
 * Whether chat UI should render for the current user.
 *
 * The chat enable/disable toggle lives in `features.chat` (from
 * `user.getFeatureFlags`), which is NOT SSR-seeded, so `chat` defaults to the
 * anon SSR value until the per-user overlay resolves. That makes the chat icon
 * flash in and then back out for users who have chat disabled. Gate on
 * `useFeatureFlagsReady()` — true once that overlay has settled (or there is no
 * logged-in user) — so we render only when the user's chat setting is known.
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
