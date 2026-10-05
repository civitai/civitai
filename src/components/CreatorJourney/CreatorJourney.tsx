import { Anchor, Badge, Card, Loader, Progress, Stack, Text, Title } from '@mantine/core';
import { IconArrowRight, IconCircle, IconCircleCheck, IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import { UserScoreDisplay } from '~/components/Account/UserScoreDisplay';
import { NextLink } from '~/components/NextLink/NextLink';
import { CREATOR_SCORE_EXPLAINER_HREF } from '~/shared/constants/creator-journey.constants';
import type { CreatorScoreKinds, CreatorScoreRung } from '~/shared/utils/creator-score-unlocks';
import {
  buildCreatorScoreLadder,
  currentCreatorScoreTier,
  describeCreatorScoreUnlocks,
  groupCreatorScoreUnlocks,
  isCreatorScoreUnlockReached,
  nextCreatorScoreRung,
} from '~/shared/utils/creator-score-unlocks';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Journey = RouterOutput['creatorJourney']['getMine'];

export function CreatorJourney() {
  const { data, isLoading } = trpc.creatorJourney.getMine.useQuery();

  if (isLoading || !data)
    return (
      <div className="flex justify-center py-16">
        <Loader />
      </div>
    );

  return <CreatorJourneyView journey={data} />;
}

export function CreatorJourneyView({ journey }: { journey: Journey }) {
  const kinds: CreatorScoreKinds = {
    total: journey.scores?.total ?? 0,
    aggregate: journey.scores?.aggregate,
  };
  const total = kinds.total;
  const rungs = buildCreatorScoreLadder(journey.unlocks, journey.tiers);
  const next = nextCreatorScoreRung(rungs, total);
  const currentTier = currentCreatorScoreTier(rungs, total);
  const articleUnlocks = journey.unlocks.filter((u) => u.scoreKind === 'articles');

  return (
    <Stack gap="xl">
      <Stack gap={4}>
        <Title order={1}>Your Creator Journey</Title>
        <Text c="dimmed">
          Where your Creator Score stands, what it unlocks next, and the badges you have earned.
          Only you can see this page.
        </Text>
      </Stack>

      <Card withBorder radius="md" p="lg">
        <div className="flex flex-wrap items-center gap-6">
          <Stack gap={4}>
            <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
              Your Creator Score
            </Text>
            <Text size="2.5rem" fw={700} lh={1}>
              {journey.scores ? numberWithCommas(Math.floor(total)) : '–'}
            </Text>
            {currentTier && (
              <Badge variant="light" color="yellow" size="lg" className="self-start">
                {currentTier.name}
              </Badge>
            )}
          </Stack>
          <div className="min-w-0 flex-1 basis-72">
            {!journey.scores ? (
              <Text size="sm" c="dimmed">
                You don&apos;t have a Creator Score yet. It starts when people react to, comment on
                or download what you share, and it updates once a day.
              </Text>
            ) : next ? (
              <NextRung rungs={rungs} next={next} total={total} />
            ) : (
              <Text size="sm">You have reached every rung on the ladder.</Text>
            )}
          </div>
        </div>
      </Card>

      <Stack gap="sm">
        <Title order={2} size="h3">
          The ladder
        </Title>
        <Stack gap={0}>
          {rungs.map((rung) => (
            <LadderRung
              key={rung.tier?.key ?? rung.minScore}
              rung={rung}
              kinds={kinds}
              isNext={rung === next}
            />
          ))}
        </Stack>
        {articleUnlocks.length > 0 && (
          <Text size="sm" c="dimmed">
            Daily article limits follow your articles score
            {journey.scores
              ? ` (${numberWithCommas(Math.floor(journey.scores.articles))})`
              : ''}{' '}
            rather than your total:{' '}
            {articleUnlocks
              .map((u) => `${numberWithCommas(u.minScore)}: ${u.label.toLowerCase()}`)
              .join('; ')}
            .
          </Text>
        )}
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          Where your score comes from
        </Title>
        <UserScoreDisplay scores={journey.scores?.breakdown} abbreviate={false} />
        <Anchor component={NextLink} href={CREATOR_SCORE_EXPLAINER_HREF} size="sm">
          How Creator Score is earned <IconArrowRight size={14} className="inline" />
        </Anchor>
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          Badges earned
        </Title>
        {journey.earned.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {journey.earned.map((badge) => (
              <Card key={badge.key} withBorder radius="md" p="sm" className="min-w-40">
                <Text fw={700}>{badge.name}</Text>
                {badge.description && (
                  <Text size="xs" c="dimmed">
                    {badge.description}
                  </Text>
                )}
                <Text size="xs" c="dimmed" mt={4}>
                  Earned {formatDate(badge.achievedAt)}
                </Text>
              </Card>
            ))}
          </div>
        ) : (
          <Text size="sm" c="dimmed">
            No badges yet.
            {journey.tiers[0] &&
              ` Your first arrives at ${
                journey.tiers[0].name
              }, a Creator Score of ${numberWithCommas(journey.tiers[0].threshold)}.`}{' '}
            Badges you earn are yours to keep.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

function rungName(rung: CreatorScoreRung) {
  return rung.tier?.name ?? `A Creator Score of ${numberWithCommas(rung.minScore)}`;
}

function NextRung({
  rungs,
  next,
  total,
}: {
  rungs: CreatorScoreRung[];
  next: CreatorScoreRung;
  total: number;
}) {
  const index = rungs.indexOf(next);
  const floor = index > 0 ? rungs[index - 1].minScore : 0;
  const progress = Math.min(Math.max(((total - floor) / (next.minScore - floor)) * 100, 0), 100);
  const pending = next.unlocks.filter((u) => u.minScore > total);

  return (
    <Stack gap={6}>
      <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
        Next: {next.tier ? `${next.tier.name} at ` : ''}
        {numberWithCommas(next.minScore)}
      </Text>
      <Progress value={progress} size="lg" radius="xl" aria-label="Progress to the next rung" />
      <Text size="sm" c="dimmed">
        {numberWithCommas(Math.ceil(next.minScore - total))} to go.
        {pending.length > 0 && ` Unlocks: ${describeCreatorScoreUnlocks(pending)}.`}
      </Text>
    </Stack>
  );
}

function LadderRung({
  rung,
  kinds,
  isNext,
}: {
  rung: CreatorScoreRung;
  kinds: CreatorScoreKinds;
  isNext: boolean;
}) {
  const reached = kinds.total >= rung.minScore;
  const Icon = reached ? IconCircleCheck : isNext ? IconArrowRight : IconCircle;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <Icon
          size={24}
          className={clsx(
            'shrink-0',
            reached ? 'text-green-6' : isNext ? 'text-blue-6' : 'text-gray-5'
          )}
        />
        <div className="w-px flex-1 bg-gray-3 dark:bg-dark-4" />
      </div>
      <div className="min-w-0 pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <Text fw={700}>{rungName(rung)}</Text>
          {rung.tier && (
            <Text size="sm" c="dimmed">
              {numberWithCommas(rung.minScore)}
            </Text>
          )}
        </div>
        {rung.tier?.hint && !reached && (
          <Text size="sm" c="dimmed" fs="italic">
            {rung.tier.hint}
          </Text>
        )}
        {rung.unlocks.length > 0 ? (
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {groupCreatorScoreUnlocks(rung.unlocks).map((group) => {
              const unlocked = group.unlocks.every((u) => isCreatorScoreUnlockReached(u, kinds));
              return (
                <li key={group.key} className="flex items-start gap-2">
                  {unlocked ? (
                    <IconCircleCheck size={16} className="mt-0.5 shrink-0 text-green-6" />
                  ) : (
                    <IconLock size={16} className="mt-0.5 shrink-0 text-gray-5" />
                  )}
                  <Text size="sm" c={unlocked ? undefined : 'dimmed'}>
                    {group.label}
                    {group.minScore !== rung.minScore &&
                      ` (from ${numberWithCommas(group.minScore)})`}
                  </Text>
                </li>
              );
            })}
          </ul>
        ) : (
          <Text size="sm" c="dimmed">
            Recognition only. Nothing new unlocks here.
          </Text>
        )}
      </div>
    </div>
  );
}
