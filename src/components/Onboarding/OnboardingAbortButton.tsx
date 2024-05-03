import { Button, ButtonProps, Stack, Text } from '@mantine/core';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';

export function OnboardingAbortButton({
  children,
  showWarning,
  ...props
}: ButtonProps & { showWarning?: boolean }) {
  const { logout } = useAccountContext();

  return (
    <Stack spacing={0}>
      <Button {...props} variant="default" onClick={() => logout()}>
        {children}
      </Button>
      {showWarning && (
        <Text size="xs" color="dimmed">
          You will be logged out.
        </Text>
      )}
    </Stack>
  );
}
