import { Card, CardProps, Center, Loader, Text } from '@mantine/core';
import { CSSProperties } from 'react';
import { env } from '~/env/client';
import { isProd } from '~/env/other';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isApril1 } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export function AssistantChat({
  width,
  height,
  ...cardProps
}: Omit<CardProps, 'children'> & {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
}) {
  const currentUser = useCurrentUser();

  const { data: { token = null } = {}, isError } = trpc.user.getToken.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const gpttUUID = isApril1()
    ? env.NEXT_PUBLIC_GPTT_UUID_ALT ?? env.NEXT_PUBLIC_GPTT_UUID
    : env.NEXT_PUBLIC_GPTT_UUID;

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
      {isError || !isProd ? (
        <Center h={height}>
          <Text>Failed to load</Text>
        </Center>
      ) : !token ? (
        <Center h={height}>
          <Loader />
        </Center>
      ) : gpttUUID ? (
        <iframe
          src={`https://app.gpt-trainer.com/widget/${gpttUUID}?token=${token}`}
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
