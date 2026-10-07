import { Button } from '@mantine/core';
import { IconGavel } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { showErrorNotification, showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Drops the judge into the newest open crucible that still has pairs for them. */
export function CrucibleJudgeNextButton() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);
    try {
      const [next] = await utils.crucible.getJudgingSuggestions.fetch(
        { browsingLevel, limit: 1 },
        { staleTime: 0 }
      );
      if (!next) {
        showInfoNotification({
          title: 'Nothing to judge right now',
          message: "You're caught up on every open crucible. New entries open new pairs.",
        });
        return;
      }
      await router.push(`/crucibles/${next.id}/judge`);
    } catch (error) {
      showErrorNotification({
        title: 'Could not find a crucible to judge',
        error: error as Error,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      variant="light"
      radius="xl"
      leftSection={<IconGavel size={18} />}
      loading={loading}
      onClick={handleClick}
    >
      Start Judging
    </Button>
  );
}
