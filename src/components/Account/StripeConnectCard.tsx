import {
  ActionIcon,
  Alert,
  Button,
  ButtonProps,
  Card,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { StripeConnectStatus } from '@prisma/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '../../utils/trpc';
import { IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { FeatureIntroductionModal } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { useUserStripeConnect } from '~/components/Stripe/stripe.utils';

const stripeConnectLoginUrl = 'https://connect.stripe.com/express_login';

export const AcceptCodeOfConduct = ({ onAccepted }: { onAccepted: () => void }) => {
  const dialog = useDialogContext();
  const utils = trpc.useContext();
  const currentUser = useCurrentUser();
  const handleClose = dialog.onClose;
  const [acceptedCoC, setAcceptedCoC] = useState(false);
  const { data, isLoading } = trpc.content.get.useQuery({
    slug: 'creators-program-coc',
  });
  const queryUtils = trpc.useContext();

  const updateUserSettings = trpc.user.setSettings.useMutation({
    async onSuccess(res) {
      queryUtils.user.getSettings.setData(undefined, res);
    },
    onError(_error, _payload, context) {
      showErrorNotification({
        title: 'Failed to accept code of conduct',
        error: new Error('Something went wrong, please try again later.'),
      });
    },
  });
  const handleConfirm = async () => {
    if (!acceptedCoC) {
      return;
    }

    await updateUserSettings.mutate({
      creatorsProgramCodeOfConductAccepted: true,
    });

    handleClose();
    onAccepted();
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton={false} radius="md">
      <Group position="apart" mb="md">
        <Text size="lg" weight="bold">
          Civitai Creator Program Code of Conduct
        </Text>
      </Group>
      <Divider mx="-lg" mb="md" />
      {isLoading || !data?.content ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack spacing="md">
          <ScrollArea.Autosize maxHeight={500}>
            <Stack>
              <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
                {data.content}
              </ReactMarkdown>
              <Checkbox
                checked={acceptedCoC}
                onChange={(event) => setAcceptedCoC(event.currentTarget.checked)}
                label="I have read and agree to the Creator Program Code of Conduct."
                size="sm"
              />
            </Stack>
          </ScrollArea.Autosize>
          <Group ml="auto">
            <Button onClick={handleClose} color="gray" disabled={updateUserSettings.isLoading}>
              Go back
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!acceptedCoC}
              loading={updateUserSettings.isLoading}
            >
              Accept
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};

const StripeConnectStatusDisplay = ({ status }: { status: StripeConnectStatus }) => {
  const { data: settings, isLoading: isLoadingSettings } = trpc.user.getSettings.useQuery();

  const targetUrl =
    status === StripeConnectStatus.PendingOnboarding
      ? '/user/stripe-connect/onboard'
      : stripeConnectLoginUrl;

  const btnProps: Partial<ButtonProps> = settings?.creatorsProgramCodeOfConductAccepted
    ? {
        // @ts-ignore - component is indeed valid prop for buttons
        component: 'a',
        href: targetUrl,
        rightIcon: <IconExternalLink size={18} />,
        target: '/blank',
        loading: isLoadingSettings,
      }
    : {
        rightIcon: <IconExternalLink size={18} />,
        loading: isLoadingSettings,
        onClick: () => {
          dialogStore.trigger({
            component: AcceptCodeOfConduct,
            props: {
              onAccepted: () => {
                window.open(targetUrl, '_blank', 'noreferrer');
              },
            },
          });
        },
      };

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

          <Button {...btnProps}>Setup Stripe Connect</Button>
        </Stack>
      );
    case StripeConnectStatus.Approved:
      return (
        <Stack>
          <Text>You&rsquo;re all set!</Text>
          <Text> You can now start receiving payments for your content!</Text>
          <Button {...btnProps}>Go to my stripe account</Button>
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
          <Button {...btnProps} color="red">
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
          <Button {...btnProps}>Go to my stripe account</Button>
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
  const { userStripeConnect, isLoading } = useUserStripeConnect();

  if (!features.creatorsProgram || !userStripeConnect) return null;

  return (
    <Card withBorder id="stripe">
      <Stack>
        <Group position="apart">
          <Title order={2} id="payment-methods">
            Stripe Connect
          </Title>
          <ActionIcon
            onClick={() => {
              dialogStore.trigger({
                component: FeatureIntroductionModal,
                props: {
                  feature: 'getting-started',
                  contentSlug: ['feature-introduction', 'stripe-connect'],
                },
              });
            }}
          >
            <IconInfoCircle />
          </ActionIcon>
        </Group>
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
