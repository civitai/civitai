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

export const getAssistantUUID = (personality: UserAssistantPersonality, isGreen?: boolean) => {
  const baseUUID = isGreen
    ? env.NEXT_PUBLIC_GPTT_UUID_GREEN ?? env.NEXT_PUBLIC_GPTT_UUID
    : env.NEXT_PUBLIC_GPTT_UUID;
  const altUUID = env.NEXT_PUBLIC_GPTT_UUID_ALT ?? baseUUID;

  const selectedUUID = personality === 'civchan' ? altUUID : baseUUID;
  return isApril1() ? altUUID : selectedUUID;
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

  const gpttUUID = getAssistantUUID(assistantPersonality ?? 'civbot', features.isGreen);

  if (!currentUser || !features.assistant || !gpttUUID) return null;

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
