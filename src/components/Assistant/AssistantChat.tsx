import { CardProps, Card, Loader, Center } from '@mantine/core';
import { CSSProperties } from 'react';
import { env } from '~/env/client.mjs';

export function AssistantChat({
  token,
  width,
  height,
  ...cardProps
}: Omit<CardProps, 'children'> & {
  token: string | null;
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
}) {
  return (
    <Card
      shadow="md"
      withBorder
      radius={16}
      sx={{
        position: 'absolute',
        bottom: '100%',
        marginBottom: 4,
        right: 0,
        width,
        zIndex: 200,
        overflow: 'hidden',
        height,
      }}
      p={0}
      {...cardProps}
    >
      {!token ? (
        <Center h={height}>
          <Loader />
        </Center>
      ) : (
        env.NEXT_PUBLIC_GPTT_UUID && (
          <iframe
            src={`https://app.gpt-trainer.com/widget/${env.NEXT_PUBLIC_GPTT_UUID}?token=${token}`}
            width={typeof width === 'number' ? width + 1 : width}
            height={height}
            style={{ margin: -1, background: 'transparent' }}
          />
        )
      )}
    </Card>
  );
}
