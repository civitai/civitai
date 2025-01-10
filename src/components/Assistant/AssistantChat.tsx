import { CardProps, Card, Loader, Center, Text } from '@mantine/core';
import { CSSProperties } from 'react';
import { env } from '~/env/client';
import { trpc } from '~/utils/trpc';
import { isProd } from '~/env/other';

export function AssistantChat({
  width,
  height,
  ...cardProps
}: Omit<CardProps, 'children'> & {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
}) {
  const { data: { token = null } = {} } = trpc.user.getToken.useQuery(undefined, {
    enabled: isProd,
  });

  return (
    <Card
      shadow="md"
      withBorder
      radius={16}
      sx={{
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
      ) : env.NEXT_PUBLIC_GPTT_UUID ? (
        <iframe
          src={`https://app.gpt-trainer.com/widget/${env.NEXT_PUBLIC_GPTT_UUID}?token=${token}`}
          width={typeof width === 'number' ? width + 1 : width}
          height={height}
          style={{ margin: -1, background: 'transparent' }}
        />
      ) : (
        <Text>Unable to load assistant</Text>
      )}
    </Card>
  );
}
