import { Button, Loader, Stack, Text, Title } from '@mantine/core';
import { IconTrophy, IconUsers } from '@tabler/icons-react';
import Link from 'next/link';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CrucibleCard } from '~/components/Cards/CrucibleCard';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';
import { getCrucibleUrl } from '~/utils/crucible-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Props = {
  crucibleId: number;
  crucibleName: string;
  sessionVotes: number;
  onlyOwnEntries: boolean;
};

export function CrucibleJudgingDoneState({
  crucibleId,
  crucibleName,
  sessionVotes,
  onlyOwnEntries,
}: Props) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading } = trpc.crucible.getJudgingSuggestions.useQuery(
    { excludeCrucibleId: crucibleId, browsingLevel, limit: 4 },
    { refetchOnWindowFocus: false }
  );
  const { items: suggestedCrucibles } = useApplyHiddenPreferences({ type: 'crucibles', data });

  return (
    <div className="mx-auto max-w-4xl py-8 text-center">
      <div className="mb-2 text-4xl">
        {onlyOwnEntries ? (
          <IconUsers className="mx-auto size-16 text-gray-500" />
        ) : (
          <IconTrophy className="mx-auto size-16 text-green-400" />
        )}
      </div>
      <Title order={2} className="mb-2 text-white">
        {onlyOwnEntries ? 'Nothing for you to judge yet' : "You've used all your votes here"}
      </Title>
      {onlyOwnEntries ? (
        <Text c="dimmed" mb="xl">
          You&apos;re never shown your own entries, so judging opens for you once at least 2 other
          creators have entered.
        </Text>
      ) : (
        <Stack gap={4} mb="xl" align="center">
          <Text c="dimmed">
            {`Each judge can vote on an entry up to ${CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY} times and is never shown the same pair twice, so there's nothing left here for you to judge.`}
          </Text>
          <Text c="dimmed">
            {sessionVotes > 0 ? `You rated ${numberWithCommas(sessionVotes)} pairs. ` : ''}
            New entries open new pairs until the crucible ends.
          </Text>
        </Stack>
      )}

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

      {suggestedCrucibles.length > 0 && (
        <>
          <Title order={4} className="mb-6 mt-8 text-left text-white">
            Continue Judging These Crucibles
          </Title>
          <div className="grid grid-cols-2 gap-4 text-left lg:grid-cols-4">
            {suggestedCrucibles.map((c) => (
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
