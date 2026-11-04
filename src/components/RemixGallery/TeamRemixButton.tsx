import { Button, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { runRemixApp } from '~/components/Image/Remix/RemixApps';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
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
  // One nonce per tap: kept until the submit settles, so a double tap names one workflow.
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);

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
        disabled={!!refusal}
        loading={pending}
        onClick={() => {
          setPending(true);
          runRemixApp({
            app: { ...TEAM_REMIX_APP, name },
            imageId,
            cost,
            nonce,
            startedMessage:
              'Added to your queue. When it is done, post it, then come back here and submit it free for your team.',
            onSettled: () => {
              setPending(false);
              setNonce(crypto.randomUUID());
            },
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
