import { Button } from '@mantine/core';
import type { ButtonProps } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { openStartStorylineModal } from '~/components/Storyline/StartStorylineModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/** Opens the start sheet; signed out, it asks them to sign in first. */
export function StartStorylineButton(props: ButtonProps) {
  const currentUser = useCurrentUser();
  const button = (
    <Button
      color="violet"
      radius="xl"
      leftSection={<IconPlus size={16} />}
      onClick={openStartStorylineModal}
      {...props}
    >
      Start a storyline
    </Button>
  );
  return currentUser ? button : <LoginRedirect reason="perform-action">{button}</LoginRedirect>;
}
