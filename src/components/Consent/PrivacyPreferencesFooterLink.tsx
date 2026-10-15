import { Button } from '@mantine/core';
import { usePrivacyUiStore } from '~/components/Consent/privacy-ui';

declare global {
  interface Window {
    admiral?: (...args: unknown[]) => void;
  }
}

/** Replaces the CMP's own floating button, which Snigel turns off once this link is live. */
export function PrivacyPreferencesFooterLink() {
  const visible = usePrivacyUiStore((state) => state.visible);
  if (!visible) return null;

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
