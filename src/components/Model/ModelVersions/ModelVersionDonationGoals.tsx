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
import classes from './ModelVersionDonationGoals.module.scss';

const DonationGoalItem = ({
  donationGoal,
  modelVersionId,
}: {
  donationGoal: ModelVersionDonationGoal;
  modelVersionId: number;
}) => {
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
      sx={{ position: 'relative' }}
      withBorder
      className={classes.donationGoalContainer}
    >
      <Stack spacing="xs">
        {donationGoal.isEarlyAccess && progress < 100 && modelVersionIsEarlyAccess && (
          <Text color="yellow" size="xs" weight={500}>
            The creator of this {resourceLabel} has set a donation goal! You can donate to make this
            resource available to everyone before the end of Early Access.
          </Text>
        )}
        <Group position="apart" noWrap align="start">
          <Text size="sm" weight={500}>
            {donationGoal.title}
          </Text>
          <Group spacing={0} position="left" align="center" noWrap>
            <CurrencyIcon currency={Currency.BUZZ} size={16} />
            <Text
              size="xs"
              sx={{
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
        <Progress
          size="xl"
          h={25}
          value={progress}
          label={`${Math.floor(progress)}%`}
          color={progress < 100 ? 'yellow.7' : 'green'}
          striped={donationGoal.active}
          animate={donationGoal.active}
        />

        {canDonate && (
          <Stack spacing="xs" mt="xs">
            <Group spacing="xs" noWrap>
              <Group spacing="xs" noWrap>
                <NumberInputWrapper
                  value={donationAmount}
                  onChange={(value) => setDonationAmount(value ?? 0)}
                  variant="filled"
                  label="Amount to donate"
                  rightSectionWidth="10%"
                  min={10}
                  max={100000}
                  icon={<CurrencyIcon currency="BUZZ" size={16} />}
                  parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
                  formatter={(value) =>
                    value && !Number.isNaN(parseFloat(value))
                      ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                      : ''
                  }
                  size={'xs'}
                  hideControls
                  labelProps={{ style: { display: 'none' } }}
                  step={10}
                  w="100%"
                  placeholder="Amount to donate"
                  disabled={donating}
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
                size="xs"
                compact
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
    <Stack spacing="sm">
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

