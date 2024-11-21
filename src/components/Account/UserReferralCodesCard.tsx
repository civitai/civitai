import {
  Text,
  Card,
  Title,
  Stack,
  Button,
  Group,
  Code,
  ActionIcon,
  Tooltip,
  Paper,
  Loader,
  Center,
} from '@mantine/core';

import { trpc } from '~/utils/trpc';
import { showSuccessNotification } from '~/utils/notifications';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useClipboard } from '@mantine/hooks';
import { IconClipboardCopy, IconTrash } from '@tabler/icons-react';
import { env } from '~/env/client.mjs';
import { constants } from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { Currency } from '~/shared/utils/prisma/enums';

export function UserReferralCodesCard() {
  const { copied, copy } = useClipboard();
  const features = useFeatureFlags();

  const { data: userReferralCodes = [], isLoading } = trpc.userReferralCode.getAll.useQuery({
    includeCount: true,
  });
  const queryUtils = trpc.useContext();
  const { mutate: upsertUserReferralCode, isLoading: upsertingCode } =
    trpc.userReferralCode.upsert.useMutation({
      onSuccess: async (_, req) => {
        showSuccessNotification({
          title: 'Success',
          message: req?.id
            ? 'Referral code updated successfully'
            : 'Referral code created successfully',
        });
        await queryUtils.userReferralCode.getAll.invalidate();
      },
    });
  const { mutate: deleteUserReferralCode, isLoading: deletingCode } =
    trpc.userReferralCode.delete.useMutation({
      onSuccess: async () => {
        showSuccessNotification({
          title: 'Success',
          message: 'Referral code has been deleted',
        });
        await queryUtils.userReferralCode.getAll.invalidate();
      },
    });

  const referralUrl = `${env.NEXT_PUBLIC_BASE_URL}/login?ref_code=`;

  return (
    <Card id="referrals" withBorder>
      <Stack>
        <Stack spacing={0}>
          <Title order={2}>Referral Codes</Title>
          {features.buzz && (
            <Text color="dimmed" size="sm">
              You can use referral codes to invite your friends to join the platform. Referring
              accounts will grant you and your friend{' '}
              <Text color="accent.5" span inline>
                <CurrencyBadge
                  currency={Currency.BUZZ}
                  unitAmount={constants.buzz.referralBonusAmount}
                />
              </Text>{' '}
              which you can use to generate content, run bounties and more!
            </Text>
          )}
        </Stack>
        <Stack>
          {isLoading ? (
            <Center>
              <Loader />
            </Center>
          ) : (
            <>
              {userReferralCodes.length === 0 ? (
                <Paper radius="md" p="lg" sx={{ position: 'relative' }} withBorder>
                  <Center>
                    <Stack spacing={2}>
                      <Text weight="bold">You have not created any referral codes</Text>
                      <Text size="sm" color="dimmed">
                        Start by creating your first referral code to invite friends.
                      </Text>
                    </Stack>
                  </Center>
                </Paper>
              ) : (
                <Stack spacing="xs">
                  {userReferralCodes.map((referralCode) => (
                    <Paper withBorder p="sm" key={referralCode.id}>
                      <Group position="apart">
                        <Stack spacing={0}>
                          <Code color="blue" style={{ textAlign: 'center' }}>
                            {referralCode.code}
                          </Code>
                          {referralCode.note && (
                            <Text color="dimmed" size="xs">
                              {referralCode.note}
                            </Text>
                          )}
                          {referralCode._count && (
                            <Text color="dimmed" size="xs">
                              Referees: {referralCode._count.referees}
                            </Text>
                          )}
                        </Stack>

                        <Group>
                          <Tooltip
                            label={copied ? 'Copied' : 'Copy referral URL'}
                            withArrow
                            withinPortal
                          >
                            <ActionIcon
                              size="md"
                              color="blue"
                              radius="xl"
                              variant="light"
                              onClick={() => copy(`${referralUrl}${referralCode.code}`)}
                            >
                              <IconClipboardCopy size={20} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete" withArrow withinPortal>
                            <ActionIcon
                              size="md"
                              color="red"
                              radius="xl"
                              variant="light"
                              onClick={() => deleteUserReferralCode({ id: referralCode.id })}
                            >
                              <IconTrash size={20} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              )}
            </>
          )}
          <Button
            disabled={userReferralCodes.length >= constants.referrals.referralCodeMaxCount}
            loading={upsertingCode || isLoading}
            onClick={() => upsertUserReferralCode()}
          >
            Generate new referral code
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
