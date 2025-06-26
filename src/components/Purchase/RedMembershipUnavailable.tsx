import { Button, Center, Container, Group, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';

import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
// import classes from '~/pages/pricing/index.module.scss';

interface RedMembershipUnavailableProps {
  onSelectGreen: () => void;
  onGoBack: () => void;
}

export function RedMembershipUnavailable({
  onSelectGreen,
  onGoBack,
}: RedMembershipUnavailableProps) {
  const features = useFeatureFlags();
  const { classNames: redClassNames } = useBuzzCurrencyConfig('red');
  const { classNames: greenClassNames } = useBuzzCurrencyConfig('green');

  return (
    <>
      <Meta
        title="Memberships | Civitai"
        description="As the leading generative AI community, we're adding new features every week. Help us keep the community thriving by becoming a Supporter and get exclusive perks."
      />
      <Container size="sm" mb="lg">
        <Stack>
          <Title className={clsx('text-center')}>Red Memberships Currently Unavailable</Title>
        </Stack>
      </Container>
      <Container size="xl">
        <Center>
          <Stack
            align="center"
            gap="xl"
            maw={600}
            className="rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 to-pink-100 p-8 shadow-xl dark:border-gray-700 dark:from-gray-900 dark:to-gray-800"
          >
            <Text size="lg" fw={700} className="text-center text-rose-700 dark:text-rose-200">
              Red memberships are currently unavailable.
            </Text>
            <Text size="md" className="text-center text-gray-700 dark:text-gray-200">
              {`We're working on bringing them back soon. In the meantime, you can still purchase individual Red Buzz or choose a Green membership.`}
            </Text>
            <Group
              gap="md"
              className="mt-2 w-full flex-col items-center justify-center sm:flex-row"
            >
              <Button
                radius="xl"
                size="lg"
                onClick={onSelectGreen}
                className={`w-full sm:w-auto ${greenClassNames?.btn}`}
                aria-label="Choose Green Membership"
              >
                Choose Green Membership
              </Button>
              {(features.nowpaymentPayments || features.coinbasePayments) && (
                <Button
                  variant="gradient"
                  gradient={{ from: 'rose', to: 'pink', deg: 90 }}
                  color="red"
                  radius="xl"
                  size="lg"
                  component={Link}
                  href="/purchase/buzz?initialBuzzType=red"
                  className={`w-full sm:w-auto ${redClassNames?.btn}`}
                  aria-label="Buy Red Buzz Instead"
                >
                  Buy Red Buzz Instead
                </Button>
              )}
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
        </Center>
      </Container>
    </>
  );
}
