import {
  Text,
  Card,
  Title,
  Stack,
  Button,
  Group,
  Code,
  Tooltip,
  Paper,
  Loader,
  Center,
} from '@mantine/core';

import { trpc } from '~/utils/trpc';
import { showSuccessNotification } from '~/utils/notifications';
import { useClipboard } from '@mantine/hooks';
import { IconClipboardCopy, IconTrash } from '@tabler/icons-react';
import { env } from '~/env/client';
import { constants } from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { Currency } from '~/shared/utils/prisma/enums';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { buzzConstants } from '~/shared/constants/buzz.constants';

export function UserReferralCodesCard() {
  const { copied, copy } = useClipboard();
  const features = useFeatureFlags();

  const { data: userReferralCodes = [], isLoading } = trpc.userReferralCode.getAll.useQuery({
    includeCount: true,
  });
  const queryUtils = trpc.useUtils();
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
        <Stack gap={0}>
          <Title order={2}>Referral Codes</Title>
          {features.buzz && (
            <Text c="dimmed" size="sm">
              You can use referral codes to invite your friends to join the platform. Referring
              accounts will grant you and your friend{' '}
              <Text c="accent.5" span inline>
                <CurrencyBadge
                  currency={Currency.BUZZ}
                  unitAmount={buzzConstants.referralBonusAmount}
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
                <Paper radius="md" p="lg" style={{ position: 'relative' }} withBorder>
                  <Center>
                    <Stack gap={2}>
                      <Text fw="bold">You have not created any referral codes</Text>
                      <Text size="sm" c="dimmed">
                        Start by creating your first referral code to invite friends.
                      </Text>
                    </Stack>
                  </Center>
                </Paper>
              ) : (
                <Stack gap="xs">
                  {userReferralCodes.map((referralCode) => (
                    <Paper withBorder p="sm" key={referralCode.id}>
                      <Group justify="space-between">
                        <Stack gap={0}>
                          <Code color="blue" style={{ textAlign: 'center' }}>
                            {referralCode.code}
                          </Code>
                          {referralCode.note && (
                            <Text c="dimmed" size="xs">
                              {referralCode.note}
                            </Text>
                          )}
                          {referralCode._count && (
                            <Text c="dimmed" size="xs">
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
                            <LegacyActionIcon
                              size="md"
                              color="blue"
                              radius="xl"
                              variant="light"
                              onClick={() => copy(`${referralUrl}${referralCode.code}`)}
                            >
                              <IconClipboardCopy size={20} />
                            </LegacyActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete" withArrow withinPortal>
                            <LegacyActionIcon
                              size="md"
                              color="red"
                              radius="xl"
                              variant="light"
                              onClick={() => deleteUserReferralCode({ id: referralCode.id })}
                            >
                              <IconTrash size={20} />
                            </LegacyActionIcon>
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
