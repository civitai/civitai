import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { IconExternalLink, IconPhoto } from '@tabler/icons-react';
import Link from 'next/link';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { WinnerPodiumCard } from '~/components/Challenge/WinnerPodiumCard';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import type {
  ChallengeWithWinnersListItem,
  ChallengeWinnerSummary,
} from '~/server/schema/challenge.schema';
import { isDefined } from '~/utils/type-guards';

export function CompletedChallengeCard({ data }: Props) {
  const { id, title, theme, endsAt, prizePool, entryCount, winners } = data;
  const challengeUrl = `/challenges/${id}/${slugit(title)}`;

  // Podium order: [2nd, 1st, 3rd] — same as detail page
  const podiumOrder = [
    winners.find((w) => w.place === 2),
    winners.find((w) => w.place === 1),
    winners.find((w) => w.place === 3),
  ].filter(isDefined) as ChallengeWinnerSummary[];

  return (
    <Paper
      radius="lg"
      withBorder
      py={{ base: 'sm', sm: 'lg' }}
      px={{ base: 'sm', sm: 'xl' }}
      className="mx-auto w-full max-w-4xl"
    >
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div className="flex min-w-0 flex-col gap-1">
            <Text size="sm" c="dimmed">
              {formatDate(endsAt, 'MMM DD, YYYY')}
            </Text>
            <Text
              component={Link}
              href={challengeUrl}
              size="xl"
              fw={700}
              lineClamp={2}
              lh={1.3}
              className="hover:underline"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              {title}
            </Text>
            {theme && (
              <Text size="sm" c="dimmed" lineClamp={1}>
                Theme: {theme}
              </Text>
            )}
            <Group gap="sm" mt={4}>
              <CurrencyBadge
                currency={Currency.BUZZ}
                unitAmount={prizePool}
                radius="xl"
                variant="light"
              />
              <Badge variant="light" color="gray" radius="xl" leftSection={<IconPhoto size={14} />}>
                {abbreviateNumber(entryCount)} entries
              </Badge>
            </Group>
          </div>
          <Badge
            component={Link}
            href={challengeUrl}
            variant="light"
            radius="xl"
            size="lg"
            rightSection={<IconExternalLink size={14} />}
            style={{ cursor: 'pointer', flexShrink: 0 }}
          >
            View
          </Badge>
        </Group>

        {/* Winner podium — same [2nd, 1st, 3rd] layout as detail page */}
        {podiumOrder.length > 0 && (
          <div className="flex items-center justify-center gap-2">
            {podiumOrder.map((winner) => (
              <WinnerPodiumCard
                key={winner.place}
                winner={winner}
                isFirst={winner.place === 1}
                className={winner.place === 1 ? 'z-10' : ''}
                compact
              />
            ))}
          </div>
        )}
      </Stack>
    </Paper>
  );
}

type Props = { data: ChallengeWithWinnersListItem };
