import {
  Progress,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
  createStyles,
  Group,
  Button,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useMutateDonationGoal } from '~/components/DonationGoal/donation-goal.util';
import { useQueryModelVersionDonationGoals } from '~/components/Model/ModelVersions/model-version.utils';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { ModelVersionDonationGoal } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';

const useStyles = createStyles((theme) => ({
  donationGoalContainer: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
  },
}));

const DonationGoalItem = ({ donationGoal }: { donationGoal: ModelVersionDonationGoal }) => {
  const { classes } = useStyles();
  const progress = Math.min(100, (donationGoal.total / donationGoal.goalAmount) * 100);
  const [donationAmount, setDonationAmount] = useState<number>(10);
  const currentUser = useCurrentUser();
  const { donate, donating } = useMutateDonationGoal();

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
        {donationGoal.isEarlyAccess && progress < 100 && (
          <Text color="yellow" size="xs" weight={500}>
            By completing this goal, this model will be out of early access and open to the public.
            Supporting this model does not grant you early access.
          </Text>
        )}
        <Group position="apart" noWrap>
          <Text size="sm">{donationGoal.title}</Text>
          <Group spacing={0} position="left" align="center" noWrap>
            <CurrencyIcon currency={Currency.BUZZ} size={16} />
            <Text size="xs">
              {donationGoal.total} / {donationGoal.goalAmount}
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
          value={progress}
          label={`${Math.floor(progress)}%`}
          color={progress < 100 ? 'yellow.7' : 'green'}
          striped
          animate
        />

        {canDonate && (
          <Stack spacing="xs" mt="xs">
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
        return <DonationGoalItem key={goal.id} donationGoal={goal} />;
      })}
    </Stack>
  );
};

type Props = {
  modelVersionId: number;
};

export default ModelVersionDonationGoals;
