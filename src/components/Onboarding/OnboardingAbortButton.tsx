import type { ButtonProps } from '@mantine/core';
import { Button, Stack, Text } from '@mantine/core';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';

export function OnboardingAbortButton({
  children,
  showWarning,
  ...props
}: ButtonProps & { showWarning?: boolean }) {
  const { logout } = useAccountContext();

  return (
    <Stack gap={0}>
      <Button {...props} variant="default" onClick={() => logout()}>
        {children}
      </Button>
      {showWarning && (
        <Text size="xs" c="dimmed">
          You will be logged out.
        </Text>
      )}
    </Stack>
  );
}
