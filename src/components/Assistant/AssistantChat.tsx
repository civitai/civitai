import type { CardProps } from '@mantine/core';
import { Card, Center, Loader, Text } from '@mantine/core';
import type { CSSProperties } from 'react';
import { getAssistantUUID } from '~/components/Assistant/AssistantButton';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { isProd } from '~/env/other';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
  const features = useFeatureFlags();
  const { assistantPersonality } = useCurrentUserSettings();

  const { data: { token = null } = {}, isError } = trpc.user.getToken.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const gpttUUID = getAssistantUUID(assistantPersonality ?? 'civbot');

  if (!currentUser || !features.assistant) return null;

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
