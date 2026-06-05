import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * Whether chat UI should render for the current user.
 *
 * The chat enable/disable toggle lives in the user's settings. `features.chat`
 * (from `user.getFeatureFlags`) is the live, optimistic source for that toggle —
 * but that query is NOT SSR-seeded, so `chat` defaults to `true` until it
 * resolves. That makes the chat icon flash in and then back out for users who
 * have chat disabled. `user.getSettings` IS SSR-seeded (`AppProvider` passes
 * `initialData`), and its `isFetched` only flips true after the confirming
 * fetch — which, under tRPC request batching, lands together with
 * `getFeatureFlags`. Gating on it lets us wait until the user's chat setting is
 * known before rendering any chat UI, eliminating the flash.
 *
 * Logged-out callers (e.g. ShareButton) fall through to the stable SSR
 * `features.chat` value, which never flickers because there is no per-user
 * override query to overlay.
 */
export function useChatEnabled() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { isFetched } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!currentUser,
    staleTime: 0,
  });
  const ready = !currentUser || isFetched;
  return ready && features.chat;
}
