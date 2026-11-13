import { Button } from '@mantine/core';
import { ShellButton } from '~/components/AppLayout/ShellDs/ShellDs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useThirdPartyConsent } from './consent.context';

export function ManageConsentFooterLink() {
  const { required, reset } = useThirdPartyConsent();
  const features = useFeatureFlags();
  if (!required) return null;

  if (features.shellDesignSystemMarkup)
    return (
      <ShellButton onClick={reset} className="px-2.5 @max-sm:px-1" size="xs" variant="subtle-gray">
        Manage cookies
      </ShellButton>
    );

  return (
    <Button onClick={reset} className="px-2.5 @max-sm:px-1" size="xs" variant="subtle" color="gray">
      Manage cookies
    </Button>
  );
}
