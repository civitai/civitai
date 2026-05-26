import { Button } from '@mantine/core';
import { useThirdPartyConsent } from './consent.context';

export function ManageConsentFooterLink() {
  const { required, reset } = useThirdPartyConsent();
  if (!required) return null;

  return (
    <Button
      onClick={reset}
      className="px-2.5 @max-sm:px-1"
      size="xs"
      variant="subtle"
      color="gray"
    >
      Manage cookies
    </Button>
  );
}
