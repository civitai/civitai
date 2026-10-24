import { Button } from '@mantine/core';
import { IconConfetti } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

/** Join the event, asking a signed-out viewer to sign in first. */
export function JoinEventButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <LoginRedirect reason="perform-action">
      <Button
        size="lg"
        radius="xl"
        onClick={onClick}
        loading={loading}
        leftSection={<IconConfetti size={20} />}
      >
        Join and get your free hat
      </Button>
    </LoginRedirect>
  );
}
