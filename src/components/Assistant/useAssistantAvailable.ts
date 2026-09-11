import { getAssistantUUID } from '~/components/Assistant/AssistantChat';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The chat's availability, in one place because two surfaces now ask: the button
 * that renders it and the support menu item that opens it. Three conditions have to
 * hold, and a menu item deriving only the first two would offer a chat that then
 * renders nothing.
 *
 * Returns the resolved personality alongside, since every caller needs it.
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
