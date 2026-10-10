import { Alert, Button, Card, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useState } from 'react';
import { Currency } from '~/shared/utils/prisma/enums';
import type { PrizeView } from '~/server/services/prize.service';
import type { PrizeBuzzType } from '~/server/schema/prize.schema';
import { getCurrencyConfig } from '~/shared/constants/currency.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const buzzTypeLabel: Record<PrizeBuzzType, string> = { green: 'Green Buzz', yellow: 'Yellow Buzz' };

export function PrizeClaimCard({ prize }: { prize: PrizeView }) {
  const utils = trpc.useUtils();
  const [buzzType, setBuzzType] = useState<PrizeBuzzType | undefined>(
    prize.choices.length === 1 ? prize.choices[0] : undefined
  );
  const claim = trpc.prize.claim.useMutation({
    onSuccess: (result) => {
      utils.prize.getById.setData({ id: prize.id }, result);
      utils.prize.getMine.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Unable to claim prize', error: new Error(error.message) }),
  });

  const shownType = prize.buzzType ?? buzzType ?? 'yellow';
  const theme = getCurrencyConfig({ currency: Currency.BUZZ, type: shownType });
  const hasChoice = prize.choices.length > 1;

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md" align="center">
        <Title order={3} ta="center">
          {prize.title}
        </Title>
        <Text fz={48} fw={600} c={theme.color} className="flex items-center gap-2">
          <CurrencyIcon currency={Currency.BUZZ} type={shownType} fill={theme.color} size={40} />
          {numberWithCommas(prize.amount)}
        </Text>

        {prize.voided ? (
          <Alert color="red">This prize is no longer available.</Alert>
        ) : prize.claimedAt && prize.buzzType ? (
          <Alert color="green" icon={<IconCircleCheck />}>
            {prize.paid
              ? `Claimed ${formatDate(prize.claimedAt)} as ${buzzTypeLabel[prize.buzzType]}${
                  prize.autoClaimed ? ' (claimed automatically)' : ''
                }.`
              : `Claimed as ${
                  buzzTypeLabel[prize.buzzType]
                }. Your Buzz is on its way and will arrive shortly.`}
          </Alert>
        ) : (
          <>
            {hasChoice ? (
              <Stack gap={4} align="center">
                <Text size="sm">Choose which Buzz to receive</Text>
                <SegmentedControl
                  value={buzzType ?? ''}
                  onChange={(value) => setBuzzType(value as PrizeBuzzType)}
                  data={prize.choices.map((choice) => ({
                    value: choice,
                    label: buzzTypeLabel[choice],
                  }))}
                />
              </Stack>
            ) : null}
            <Group>
              <Button
                size="lg"
                loading={claim.isPending}
                disabled={!buzzType}
                onClick={() => claim.mutate({ id: prize.id, buzzType })}
              >
                Claim prize
              </Button>
            </Group>
            <Text size="xs" c="dimmed" ta="center">
              Unclaimed prizes are paid automatically{hasChoice ? ' as Green Buzz' : ''} on{' '}
              {formatDate(prize.autoClaimAt)}.
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}
