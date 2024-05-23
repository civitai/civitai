import { Box, useMantineTheme } from '@mantine/core';
import { Adunit } from '~/components/Ads/AdUnit';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function Test() {
  const theme = useMantineTheme();

  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.orchestrator.getTextToImageRequests.useInfiniteQuery(
    {},
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      enabled: !!currentUser,
    }
  );

  console.log(data);

  return <>Hello World</>;
}
