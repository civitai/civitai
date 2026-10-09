import { Button, Loader, Stack, Text, Title } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconTrophy, IconUsers } from '@tabler/icons-react';
import { LazyMotion } from 'motion/react';
import { circle as MotionCircle, path as MotionPath } from 'motion/react-m';
import Link from 'next/link';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CrucibleCard } from '~/components/Cards/CrucibleCard';
import { CrucibleJudgeNextButton } from '~/components/Crucible/CrucibleJudgeNextButton';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';
import { getCrucibleUrl } from '~/utils/crucible-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);

function CaughtUpCheck() {
  const motionOn = !useReducedMotion(true);
  // The circle scales in and the check draws on. Both are decoration: the heading carries the news.
  return (
    <LazyMotion features={loadMotion} strict>
      <svg viewBox="0 0 64 64" className="mx-auto size-16" aria-hidden>
        <MotionCircle
          cx="32"
          cy="32"
          r="30"
          fill="rgba(64, 192, 87, 0.15)"
          stroke="#40c057"
          strokeWidth="3"
          style={{ transformOrigin: '32px 32px' }}
          initial={motionOn ? { scale: 0.6 } : false}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        />
        <MotionPath
          d="M20 33 L28 41 L44 24"
          fill="none"
          stroke="#40c057"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={motionOn ? { pathLength: 0 } : false}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, delay: 0.15, ease: 'easeOut' }}
        />
      </svg>
    </LazyMotion>
  );
}

type Props = {
  crucibleId: number;
  crucibleName: string;
  crucibleCreatedAt: Date;
  sessionVotes: number;
  onlyOwnEntries: boolean;
  votesUsedUp: boolean;
};

export function CrucibleJudgingDoneState({
  crucibleId,
  crucibleName,
  crucibleCreatedAt,
  sessionVotes,
  onlyOwnEntries,
  votesUsedUp,
}: Props) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading } = trpc.crucible.getJudgingSuggestions.useQuery(
    // Over-fetched: hidden preferences filter client-side, and 4 could all be hidden.
    { excludeCrucibleId: crucibleId, browsingLevel, limit: 12 },
    { refetchOnWindowFocus: false }
  );
  const { items: suggestedCrucibles } = useApplyHiddenPreferences({ type: 'crucibles', data });
  const shownCrucibles = suggestedCrucibles.slice(0, 4);

  return (
    <div className="mx-auto max-w-4xl py-8 text-center">
      <div className="mb-2 text-4xl">
        {onlyOwnEntries ? (
          <IconUsers className="mx-auto size-16 text-gray-500" />
        ) : votesUsedUp ? (
          <CaughtUpCheck />
        ) : (
          <IconTrophy className="mx-auto size-16 text-green-400" />
        )}
      </div>
      <Title order={2} className="mb-2 text-white">
        {onlyOwnEntries
          ? 'Nothing for you to judge yet'
          : votesUsedUp
          ? "You're caught up here"
          : 'Nothing to judge right now'}
      </Title>
      {onlyOwnEntries ? (
        <Text c="dimmed" mb="xl">
          You&apos;re never shown your own entries, so judging opens for you once at least 2 other
          creators have entered.
        </Text>
      ) : !votesUsedUp ? (
        <Text c="dimmed" mb="xl">
          There are no pairs for you to judge right now. Some entries may be hidden by your content
          settings, and new entries open new pairs until the crucible ends.
        </Text>
      ) : (
        <Stack gap={4} mb="xl" align="center">
          <Text c="dimmed">
            {sessionVotes > 0 ? `You rated ${numberWithCommas(sessionVotes)} pairs. ` : ''}
            {`You judged every pair open to you in ${crucibleName}. New entries open new pairs until it ends.`}
          </Text>
          <Text size="sm" c="dimmed">
            {`Each judge can vote on an entry up to ${CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY} times and is never shown the same pair twice, so there's nothing left here for you to judge.`}
          </Text>
        </Stack>
      )}

      {votesUsedUp && !onlyOwnEntries ? (
        <Stack gap="sm" mb="xl" align="center">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button
              variant="default"
              component={Link}
              href={getCrucibleUrl(crucibleId, crucibleName)}
            >
              Back to crucible
            </Button>
            <CrucibleJudgeNextButton
              cycleFrom={{ id: crucibleId, createdAt: crucibleCreatedAt }}
              variant="primary"
              label="Next crucible"
            />
          </div>
          {suggestedCrucibles.length > 0 && (
            <Text size="sm" fw={600} c="green">
              {suggestedCrucibles.length} more{' '}
              {suggestedCrucibles.length === 1 ? 'crucible has' : 'crucibles have'} pairs for you
            </Text>
          )}
        </Stack>
      ) : (
        <Button
          variant="light"
          size="lg"
          component={Link}
          href={getCrucibleUrl(crucibleId, crucibleName)}
          mb="xl"
          maw="100%"
          classNames={{ inner: 'min-w-0', label: 'truncate' }}
        >
          Back to {crucibleName}
        </Button>
      )}

      {shownCrucibles.length > 0 && (
        <>
          <Title order={4} className="mb-6 mt-8 text-left text-white">
            Continue Judging These Crucibles
          </Title>
          <div className="grid grid-cols-2 gap-4 text-left lg:grid-cols-4">
            {shownCrucibles.map((c) => (
              <div key={c.id} className="flex flex-col gap-2">
                <CrucibleCard data={c} />
                <Button component={Link} href={`/crucibles/${c.id}/judge`} fullWidth>
                  Start Judging
                </Button>
              </div>
            ))}
          </div>
        </>
      )}

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader size="md" />
        </div>
      )}
    </div>
  );
}
