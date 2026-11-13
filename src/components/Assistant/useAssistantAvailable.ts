import { getAssistantUUID } from '~/components/Assistant/AssistantChat';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The chat's availability for the two footer surfaces: the button that renders it and
 * the support menu item that opens it. Three conditions have to hold, and a menu item
 * deriving only the first two would offer a chat that then renders nothing.
 *
 * 🔴 NOT the only derivation, and deliberately not unified with the other one yet.
 * `AssistantChat` derives the same triple itself and passes `features.isGreen` to
 * `getAssistantUUID`, which this does not — so on the green domain, a deployment with
 * only `NEXT_PUBLIC_GPTT_UUID_GREEN` set hides the footer CivBot item while `/support`'s
 * chat renders fine. This calls `getAssistantUUID(personality)` without `isGreen`,
 * unlike `AssistantChat`. Passing `isGreen` would change which env var the footer reads
 * on civitai.red, which is its own change with its own testing.
 */
export function useAssistantAvailable() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { assistantPersonality } = useCurrentUserSettings();

  if (!currentUser || !features.assistant) return null;

  const personality = assistantPersonality ?? 'civbot';
  const uuid = getAssistantUUID(personality);
  if (!uuid) return null;

  return { personality, uuid };
}
