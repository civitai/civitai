import { Button, ButtonProps } from '@mantine/core';
import { IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { AssistantChat } from '~/components/Assistant/AssistantChat';
import { env } from '~/env/client.mjs';
import { isDev } from '~/env/other';
import { trpc } from '~/utils/trpc';

const WIDTH = 320;
const HEIGHT = 500;
export function AssistantButton({ ...props }: ButtonProps) {
  const [opened, setOpened] = useState(false);
  const { data: { token = null } = {} } = trpc.user.getToken.useQuery(undefined, {
    enabled: opened,
  });
  if (!env.NEXT_PUBLIC_GPTT_UUID && isDev) return null;

  return (
    <>
      <AssistantChat
        token={token}
        width={WIDTH}
        height={HEIGHT}
        style={{ display: opened ? 'block' : 'none' }}
      />
      <Button
        px="xs"
        {...props}
        onClick={() => setOpened((x) => !x)}
        color={opened ? 'gray' : 'blue'}
      >
        {opened ? <IconX size={20} stroke={2.5} /> : <IconMessageChatbot size={20} stroke={2.5} />}
      </Button>
    </>
  );
}
