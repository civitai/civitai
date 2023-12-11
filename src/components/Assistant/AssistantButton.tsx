import { Button, ButtonProps, Card, Loader, Center } from '@mantine/core';
import { IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useState } from 'react';
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
  if (!env.NEXT_PUBLIC_GPTT_UUID && !isDev) return null;

  return (
    <>
      <Card
        style={{ display: opened ? 'block' : 'none' }}
        shadow="md"
        withBorder
        radius={16}
        sx={{
          position: 'absolute',
          bottom: '100%',
          marginBottom: 4,
          right: 0,
          width: WIDTH,
          zIndex: 200,
          overflow: 'hidden',
          height: HEIGHT,
        }}
        p={0}
      >
        {!token ? (
          <Center h={HEIGHT}>
            <Loader />
          </Center>
        ) : (
          env.NEXT_PUBLIC_GPTT_UUID && (
            <iframe
              src={`https://app.gpt-trainer.com/gpt-trainer-widget/${env.NEXT_PUBLIC_GPTT_UUID}?token=${token}`}
              width={WIDTH + 1}
              height={HEIGHT}
              style={{ margin: -1, background: 'transparent' }}
            />
          )
        )}
      </Card>
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
