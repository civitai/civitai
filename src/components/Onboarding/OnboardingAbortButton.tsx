import { ButtonProps, Stack, Button, Text } from '@mantine/core';
import { signOut } from 'next-auth/react';

export function OnboardingAbortButton({
  children,
  showWarning,
  ...props
}: ButtonProps & { showWarning?: boolean }) {
  const handleCancelOnboarding = () => signOut();
  return (
    <Stack spacing={0}>
      <Button {...props} variant="default" onClick={handleCancelOnboarding}>
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
