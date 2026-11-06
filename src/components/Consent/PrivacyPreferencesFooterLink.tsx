import { Button } from '@mantine/core';
import { ShellButton } from '~/components/AppLayout/ShellDs/ShellDs';
import { usePrivacyUiStore } from '~/components/Consent/privacy-ui';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

declare global {
  interface Window {
    admiral?: (...args: unknown[]) => void;
  }
}

/** Replaces the CMP's own floating button, which Snigel turns off once this link is live. */
export function PrivacyPreferencesFooterLink() {
  const visible = usePrivacyUiStore((state) => state.visible);
  const features = useFeatureFlags();
  if (!visible) return null;

  if (features.shellDesignSystemMarkup)
    return (
      <ShellButton
        onClick={() => window.admiral?.('show', 'cmp.settings')}
        className="px-2.5 @max-sm:px-1"
        size="xs"
        variant="subtle-gray"
      >
        Privacy Preferences
      </ShellButton>
    );

  return (
    <Button
      onClick={() => window.admiral?.('show', 'cmp.settings')}
      className="px-2.5 @max-sm:px-1"
      size="xs"
      variant="subtle"
      color="gray"
    >
      Privacy Preferences
    </Button>
  );
}
