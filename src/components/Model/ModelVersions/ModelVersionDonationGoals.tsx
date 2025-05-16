import {
  Progress,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
  Group,
  Button,
  Anchor,
  Tooltip,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { Currency } from '~/shared/utils/prisma/enums';
import { IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useMutateDonationGoal } from '~/components/DonationGoal/donation-goal.util';
import {
  useModelVersionPermission,
  useQueryModelVersionDonationGoals,
} from '~/components/Model/ModelVersions/model-version.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ModelVersionDonationGoal } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

const DonationGoalItem = ({
  donationGoal,
  modelVersionId,
}: {
  donationGoal: ModelVersionDonationGoal;
  modelVersionId: number;
}) => {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const progress = Math.min(100, (donationGoal.total / donationGoal.goalAmount) * 100);
  const [donationAmount, setDonationAmount] = useState<number>(10);
  const currentUser = useCurrentUser();
  const { donate, donating } = useMutateDonationGoal();

  const { modelVersion } = useModelVersionPermission({
    modelVersionId,
  });

  const earlyAccessEndsAt = modelVersion?.earlyAccessEndsAt;
  const modelVersionIsEarlyAccess =
    modelVersion?.earlyAccessEndsAt && (modelVersion?.earlyAccessEndsAt ?? new Date()) > new Date();

  const canDonate = donationGoal.userId !== currentUser?.id && donationGoal.active;

  const onDonate = async () => {
    if (donating) {
      return;
    }

    await donate({
      donationGoalId: donationGoal.id,
      amount: donationAmount,
    });

    showSuccessNotification({
      title: 'Donation successful',
      message: 'Thank you for supporting this model!',
    });
  };

  const resourceLabel = getDisplayName(modelVersion?.model.type ?? '');

  return (
    <Paper
      key={donationGoal.id}
      radius="md"
      p="xs"
      style={{
        background: colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
        position: 'relative',
      }}
      withBorder
    >
      <Stack gap="xs">
        {donationGoal.isEarlyAccess && progress < 100 && modelVersionIsEarlyAccess && (
          <Text c="yellow" size="xs" weight={500}>
            The creator of this {resourceLabel} has set a donation goal! You can donate to make this
            resource available to everyone before the end of Early Access.
          </Text>
        )}
        <Group justify="space-between" wrap="nowrap" align="start">
          <Text size="sm" weight={500}>
            {donationGoal.title}
          </Text>
          <Group gap={0} justify="left" align="center" wrap="nowrap">
            <CurrencyIcon currency={Currency.BUZZ} size={16} />
            <Text
              size="xs"
              style={{
                whiteSpace: 'nowrap',
              }}
            >
              {numberWithCommas(donationGoal.total)} / {numberWithCommas(donationGoal.goalAmount)}
            </Text>
          </Group>
        </Group>
        {donationGoal.description && (
          <ContentClamp maxHeight={0} labelSize="xs" label="Show Description">
            <Text size="xs">{donationGoal.description}</Text>
          </ContentClamp>
        )}
        <Progress.Root size="xl" style={{ height: 25 }}>
          <Progress.Section
            value={progress}
            color={progress < 100 ? 'yellow.7' : 'green'}
            striped={donationGoal.active}
            animated={donationGoal.active}
          >
            <Progress.Label>{Math.floor(progress)}%</Progress.Label>
          </Progress.Section>
        </Progress.Root>

        {canDonate && (
          <Stack gap="xs" mt="xs">
            <Group gap="xs" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <NumberInputWrapper
                  value={donationAmount}
                  onChange={(value) => setDonationAmount(Number(value ?? 0))}
                  variant="filled"
                  label="Amount to donate"
                  rightSectionWidth="10%"
                  min={10}
                  max={100000}
                  leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                  size={'xs'}
                  hideControls
                  labelProps={{ style: { display: 'none' } }}
                  step={10}
                  w="100%"
                  placeholder="Amount to donate"
                  disabled={donating}
                  allowDecimal={false}
                  allowNegative={false}
                />
                <Tooltip
                  label="Purchasing the model for generation or download will contribute to the donation goal."
                  multiline
                  maw={250}
                >
                  <IconInfoCircle />
                </Tooltip>
              </Group>
              <BuzzTransactionButton
                onPerformTransaction={onDonate}
                label="Donate"
                buzzAmount={donationAmount}
                color="yellow.7"
                size="compact-xs"
                h={30}
                disabled={!donationAmount}
                loading={donating}
                ml="auto"
              />
            </Group>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
};

const ModelVersionDonationGoals = ({ modelVersionId }: Props) => {
  const { donationGoals, isLoading } = useQueryModelVersionDonationGoals({
    modelVersionId: modelVersionId,
  });
  const features = useFeatureFlags();

  if (!features.donationGoals) {
    return null;
  }

  if (donationGoals?.length === 0 && !isLoading) {
    return null;
  }

  if (isLoading) {
    // Return skeleton...
    return (
      <Stack>
        <Skeleton height={20} width="100%" />
        <Skeleton height={50} width="100%" />
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Title order={4} mb={0}>
        Support this model
      </Title>
      {donationGoals.map((goal) => {
        return (
          <DonationGoalItem key={goal.id} donationGoal={goal} modelVersionId={modelVersionId} />
        );
      })}
    </Stack>
  );
};

type Props = {
  modelVersionId: number;
};

export default ModelVersionDonationGoals;
