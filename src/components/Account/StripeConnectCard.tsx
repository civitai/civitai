import {
  Accordion,
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Divider,
  Group,
  GroupProps,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { StripeConnectStatus } from '@prisma/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '../../utils/trpc';
import { IconExternalLink } from '@tabler/icons-react';

const stripeConnectLoginUrl = 'https://connect.stripe.com/express_login';

const StripeConnectStatusDisplay = ({ status }: { status: StripeConnectStatus }) => {
  switch (status) {
    case StripeConnectStatus.PendingOnboarding:
      return (
        <Stack>
          <Text>
            Looks like you&rsquo;re one step away from completing your setup and start getting paid!
          </Text>
          <Text>
            Click the button below to create your Stripe connect account and start receiving money.
          </Text>

          <Button
            component="a"
            href="/user/stripe-connect/onboard"
            rightIcon={<IconExternalLink size={18} />}
            target="/blank"
          >
            Setup Stripe Connect
          </Button>
        </Stack>
      );
    case StripeConnectStatus.Approved:
      return (
        <Stack>
          <Text>You&rsquo;re all set!</Text>
          <Text> You can now start receiving payments for your content!</Text>
          <Button
            component="a"
            href={stripeConnectLoginUrl}
            target="/blank"
            rightIcon={<IconExternalLink size={18} />}
          >
            Go to my stripe account
          </Button>
        </Stack>
      );
    case StripeConnectStatus.Rejected:
      return (
        <Stack>
          <Text color="red" weight="bold">
            Looks like you can&rsquo;t receive payments
          </Text>
          <Text>
            You can login into your stripe account to see why your account was rejected and try to
            fix whatever issues may have been found.
          </Text>
          <Button
            component="a"
            href="https://connect.stripe.com/express_login"
            target="/blank"
            rightIcon={<IconExternalLink size={18} />}
            color="red"
          >
            Go to my stripe account
          </Button>
        </Stack>
      );
    case StripeConnectStatus.PendingVerification:
      return (
        <Stack>
          <Text weight="bold">Your account is pending verification</Text>
          <Text>
            Once your account is approved and verified you will be able to start receiving payments
            for your content. Stripe verification process can take 3 to 5 business days, so please
            be patient.
          </Text>
          <Text>
            If you want to check information on your progress, or update your details, feel free to
            visit your Stripe Connect account.
          </Text>
          <Button
            component="a"
            href="https://connect.stripe.com/express_login"
            target="/blank"
            rightIcon={<IconExternalLink size={18} />}
          >
            Go to my stripe account
          </Button>
        </Stack>
      );
    default:
      return (
        <Stack>
          <Alert color="red">
            It looks like you are not authorized to setup an account. Please contact support.
          </Alert>
        </Stack>
      );
  }
};

export function StripeConnectCard() {
  const features = useFeatureFlags();
  const { data: userStripeConnect, isLoading } = trpc.userStripeConnect.get.useQuery(undefined, {
    enabled: !!features.creatorsProgram,
  });

  if (!features.creatorsProgram) return null;

  return (
    <Card withBorder id="stripe">
      <Stack>
        <Title order={2} id="payment-methods">
          Stripe Connect
        </Title>
      </Stack>

      <Divider my="xl" />

      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : !userStripeConnect ? (
        <Stack>
          <Alert color="red">
            It looks like you are not authorized to receive payments or setup your account. Please
            contact support.
          </Alert>
        </Stack>
      ) : (
        <Stack>
          <StripeConnectStatusDisplay status={userStripeConnect.status} />
        </Stack>
      )}
    </Card>
  );
}
