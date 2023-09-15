import { Button, ButtonProps, Card } from '@mantine/core';
import { IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { env } from '~/env/client.mjs';

const WIDTH = 320;
const HEIGHT = 500;
export function AssistantButton({ ...props }: ButtonProps) {
  const [opened, setOpened] = useState(false);

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
        <iframe
          src={`https://app.gpt-trainer.com/gpt-trainer-widget/${env.NEXT_PUBLIC_GPTT_UUID}`}
          width={WIDTH + 1}
          height={HEIGHT}
          style={{ margin: -1, background: 'transparent' }}
        />
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
