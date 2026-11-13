import { Badge, Button, Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconClock } from '@tabler/icons-react';
import { mutedNoticeVariant } from '~/components/Generation/muted-notice.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useOpenTosReacceptance } from '~/hooks/useTosReacceptancePrompt';
import { trpc } from '~/utils/trpc';

export function GenerationMutedNotice() {
  const currentUser = useCurrentUser();
  const openTosReacceptance = useOpenTosReacceptance();
  const { data: tosOffer } = trpc.strike.getMyTosReacceptanceOffer.useQuery(undefined, {
    enabled: !!currentUser?.muted && !currentUser.mutedAt,
  });
  const variant = mutedNoticeVariant({
    mutedAt: currentUser?.mutedAt,
    tosReacceptanceOffered: !!tosOffer?.offered && !!openTosReacceptance,
  });
  const isUpheld = variant === 'upheld';

  return (
    <Center h="100%" w="100%" px="md">
      <Stack gap="lg" align="center" maw={520}>
        <ThemeIcon size="xl" radius="xl" color="yellow">
          <IconAlertTriangle />
        </ThemeIcon>

        <Text ta="center" fw={600} size="lg">
          Account Restricted
        </Text>

        {isUpheld ? (
          <Text ta="center" size="sm" c="dimmed">
            Your account has been reviewed and the restriction has been upheld. You are unable to
            post content or use the generation feature.
          </Text>
        ) : variant === 'accept-terms' ? (
          <Text ta="center" size="sm" c="dimmed">
            Your account has been restricted after 2 strikes. While restricted, you are unable to
            post content or use the generation feature. Review and accept the Terms of Service to
            lift the restriction.
          </Text>
        ) : (
          <Text ta="center" size="sm" c="dimmed">
            Your account has been restricted due to potential Terms of Service violations. While
            restricted, you are unable to post content or use the generation feature. A moderator
            will review your account and you will receive a notification within 2 business days. You
            do not need to contact us.
          </Text>
        )}

        {variant === 'accept-terms' ? (
          <Button onClick={openTosReacceptance}>Review and accept the Terms</Button>
        ) : (
          <Stack gap="xs" align="center">
            <Text size="sm" c="dimmed">
              Status:
            </Text>
            {isUpheld ? (
              <Badge color="red" variant="light" size="lg">
                Upheld
              </Badge>
            ) : (
              <Badge color="yellow" variant="light" size="lg" leftSection={<IconClock size={14} />}>
                Pending Review
              </Badge>
            )}
          </Stack>
        )}
      </Stack>
    </Center>
  );
}
