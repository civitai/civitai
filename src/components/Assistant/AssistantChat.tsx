import type { CardProps } from '@mantine/core';
import { Card, Center, Loader, Text } from '@mantine/core';
import type { CSSProperties } from 'react';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { isProd } from '~/env/other';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
import type { UserAssistantPersonality } from '~/server/schema/user.schema';
import { isApril1 } from '~/utils/date-helpers';

const assistantMap: { [p in UserAssistantPersonality]: string | undefined } = {
  civbot: env.NEXT_PUBLIC_GPTT_UUID,
  civchan: env.NEXT_PUBLIC_GPTT_UUID_ALT ?? env.NEXT_PUBLIC_GPTT_UUID,
};

export const getAssistantUUID = (personality: UserAssistantPersonality) => {
  return isApril1() ? assistantMap['civchan'] : assistantMap[personality];
};

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
      style={{
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
