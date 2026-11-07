import { Button, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { openRemixAppModal } from '~/components/Dialog/triggers/remix-app';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { TEAM_REMIX_APP } from '~/shared/constants/remix-apps.constants';
import { trpc } from '~/utils/trpc';

/**
 * Runs the team remix app on a hatted image. Shown only where the server says the result could be
 * submitted here free for the viewer's team; the prompt and team never leave the server.
 */
export function TeamRemixButton({ imageId }: { imageId: number }) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.remixApp.teamQuote.useQuery(
    { imageId },
    { enabled: !!features.remixApps && !!currentUser, staleTime: 3 * 60 * 1000, retry: false }
  );
  if (!data) return null;

  const refusal = 'refusal' in data.price ? data.price.refusal : undefined;
  const cost = 'cost' in data.price ? data.price.cost : undefined;
  const name = `Remix for Team ${data.team}`;

  return (
    <>
      <Button
        variant="light"
        color="grape"
        radius="md"
        leftSection={<IconSparkles size={16} />}
        rightSection={
          !refusal && (
            <CurrencyBadge currency="BUZZ" unitAmount={cost ?? 0} loading={isLoading} size="sm" />
          )
        }
        disabled={cost == null}
        onClick={() => {
          openRemixAppModal({
            app: { slug: TEAM_REMIX_APP.slug, name, runtime: false },
            imageId,
            note: 'When it is done, post it, then come back here and submit it free for your team (free team submits are limited per day).',
          });
        }}
      >
        Remix for your team
      </Button>
      {refusal && (
        <Text size="xs" ta="center" c="dimmed" mt={-4}>
          {refusal}
        </Text>
      )}
    </>
  );
}
