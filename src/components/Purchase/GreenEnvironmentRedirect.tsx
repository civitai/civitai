import { Button, Center, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { env } from '~/env/client';
import { QS } from '~/utils/qs';
import type { JoinRedirectReason } from '~/utils/join-helpers';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { Meta } from '~/components/Meta/Meta';

interface GreenEnvironmentRedirectProps {
  /** Callback when user wants to go back */
  onGoBack: () => void;
  /** The destination path on the green environment (e.g., '/pricing', '/purchase/buzz') */
  destinationPath?: string;
  /** Additional query parameters to include in the redirect */
  queryParams?: Record<string, string | number | undefined>;
  /** Custom title for the page */
  title?: string;
  /** Custom heading text */
  heading?: string;
  /** Custom description text */
  description?: string;
  /** Custom button text */
  buttonText?: string;
  /** Whether to show the full page layout or just the redirect component */
  fullPageLayout?: boolean;
}

export function GreenEnvironmentRedirect({
  onGoBack,
  destinationPath = '/pricing',
  queryParams = {},
  title = 'Redirecting to Green Environment | Civitai',
  heading = 'Redirecting to Civitai Green',
  description = 'A new window should open and redirect you to Civitai Green pricing page.',
  buttonText = 'Go to Green Pricing Page',
  fullPageLayout = true,
}: GreenEnvironmentRedirectProps) {
  const { classNames: greenClassNames } = useBuzzCurrencyConfig('green');

  const handleManualRedirect = () => {
    const query = {
      buzzType: 'green',
      'sync-account': 'blue',
      ...queryParams,
    };

    window.location.href = `//${
      env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN
    }${destinationPath}?${QS.stringify(query)}`;
  };

  const redirectContent = (
    <Stack
      align="center"
      gap="xl"
      maw={600}
      className="rounded-2xl border border-green-200 bg-gradient-to-br from-green-50 to-emerald-100 p-8 shadow-xl dark:border-gray-700 dark:from-gray-900 dark:to-gray-800"
    >
      <Loader type="bars" size="md" color="green" />
      <Text size="lg" fw={700} className="text-center text-green-700 dark:text-green-200">
        Opening Civitai Green
      </Text>
      <Text size="md" className="text-center text-gray-700 dark:text-gray-200">
        {description}
        <br />
        If it doesn&apos;t open automatically, please check your browser&apos;s popup blocker
        settings.
      </Text>
      <Group gap="md" className="mt-2 w-full flex-col items-center justify-center sm:flex-row">
        <Button
          variant="light"
          color="green"
          radius="xl"
          size="lg"
          onClick={handleManualRedirect}
          className={`w-full sm:w-auto ${greenClassNames?.btn} px-6 py-4 text-lg`}
          aria-label={buttonText}
        >
          {buttonText}
        </Button>
        <Button
          variant="subtle"
          color="gray"
          radius="xl"
          size="md"
          onClick={onGoBack}
          className="mt-2 w-full border border-gray-300 px-8 py-2 text-base font-medium transition-colors hover:bg-gray-100 sm:mt-0 sm:w-auto dark:border-gray-700 dark:hover:bg-gray-800"
          aria-label="Go Back"
        >
          Go Back
        </Button>
      </Group>
    </Stack>
  );

  if (!fullPageLayout) {
    return <Center>{redirectContent}</Center>;
  }

  return (
    <>
      <Meta title={title} description="Redirecting you to the Green environment." />
      <Container size="sm" mb="lg">
        <Stack>
          <Title className={clsx('text-center')}>{heading}</Title>
        </Stack>
      </Container>
      <Container size="xl">
        <Center>{redirectContent}</Center>
      </Container>
    </>
  );
}
