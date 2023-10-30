import { Button, ButtonProps, Card, Center } from '@mantine/core';
import { IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { env } from '~/env/client.mjs';
import { NoContent } from '../NoContent/NoContent';

const WIDTH = 320;
const HEIGHT = 500;
const URL = `https://app.gpt-trainer.com/gpt-trainer-widget/${env.NEXT_PUBLIC_GPTT_UUID}`;

async function checkPageExists(url: string) {
  return fetch(url, { method: 'HEAD' })
    .then((res) => res.ok)
    .catch(() => false);
}

export function AssistantButton({ ...props }: ButtonProps) {
  const [opened, setOpened] = useState(false);
  const [loaded, setLoaded] = useState(true);

  useEffect(() => {
    async function loadIFrameData() {
      const result = await checkPageExists(URL);
      setLoaded(result);
    }

    loadIFrameData();
  }, [opened]);

  if (!env.NEXT_PUBLIC_GPTT_UUID) return null;

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
        {loaded ? (
          <iframe
            src={URL}
            width={WIDTH + 1}
            height={HEIGHT}
            style={{ margin: -1, background: 'transparent' }}
          />
        ) : (
          <Center p="md" h="100%">
            <NoContent
              iconSize={64}
              message="CivBot is not available at the moment. Please try again later"
            />
          </Center>
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
