import type { ButtonProps } from '@mantine/core';
import {
  Alert,
  Button,
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
import { trpc } from '../../utils/trpc';
import { IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import rehypeRaw from 'rehype-raw';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { useDialogContext } from '~/components/Dialog/DialogContext';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StripeConnectStatus, TipaltiStatus } from '~/server/common/enums';
import {
  useTipaltiConfigurationUrl,
  useUserPaymentConfiguration,
} from '~/components/UserPaymentConfiguration/util';
import dynamic from 'next/dynamic';
import { useMutateUserSettings } from '~/components/UserSettings/hooks';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

const stripeConnectLoginUrl = 'https://connect.stripe.com/express_login';

export const AcceptCodeOfConduct = ({ onAccepted }: { onAccepted: () => void }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [acceptedCoC, setAcceptedCoC] = useState(false);
  const { data, isLoading } = trpc.content.get.useQuery({
    slug: 'creators-program-coc',
  });

  const updateUserSettings = useMutateUserSettings({
    onError() {
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
      creatorsProgramCodeOfConductAccepted: new Date(),
    });

    handleClose();
    onAccepted();
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton={false} radius="md">
      <Group justify="space-between" mb="md">
        <Text size="lg" fw="bold">
          Civitai Creator Program Code of Conduct
        </Text>
      </Group>
      <Divider mx="-lg" mb="md" />
      {isLoading || !data?.content ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack gap="md">
          <ScrollArea.Autosize mah={500}>
            <Stack>
              <CustomMarkdown rehypePlugins={[rehypeRaw]}>{data.content}</CustomMarkdown>
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
          <Text c="red" fw="bold">
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
          <Text fw="bold">Your account is pending verification</Text>
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

const FeatureIntroductionModal = dynamic(
  () => import('~/components/FeatureIntroduction/FeatureIntroduction')
);

const StripeConnectConfigurationCard = () => {
  const { userPaymentConfiguration, isLoading } = useUserPaymentConfiguration();
  if (!userPaymentConfiguration) return null;

  if (userPaymentConfiguration?.stripeAccountId) {
    // True as of now, we don't support stripe anymore
    return (
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Stripe Connect</Title>
        </Group>

        <Text>
          We will no longer be supporting Stripe connect for payments. Please setup Tipalti in order
          to receive payments.
        </Text>
      </Stack>
    );
  }

  return (
    <>
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Stripe Connect</Title>
          <LegacyActionIcon
            color="gray"
            variant="subtle"
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
          </LegacyActionIcon>
        </Group>
      </Stack>

      <Divider my="xl" />

      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : !userPaymentConfiguration ? (
        <Stack>
          <Alert color="red">
            It looks like you are not authorized to receive payments or setup your account yet.
          </Alert>
        </Stack>
      ) : (
        <Stack>
          <StripeConnectStatusDisplay
            status={userPaymentConfiguration.stripeAccountStatus as StripeConnectStatus}
          />
        </Stack>
      )}
    </>
  );
};

const TipaltiConfigurationCard = () => {
  const { userPaymentConfiguration } = useUserPaymentConfiguration();

  if (!userPaymentConfiguration) return null;

  if (!userPaymentConfiguration?.tipaltiAccountId) {
    // True as of now, we don't support stripe anymore
    return (
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Tipalti Account</Title>
        </Group>

        <Text>
          Tipalti is the new way to receive payments. We are slowly rolling invitations to Tipalti
          to all creators. If you have not received an invitation yet, please be patient.
        </Text>
        <Text>A notification will be sent to you once you are invited to Tipalti.</Text>
      </Stack>
    );
  }

  return (
    <>
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Tipalti Account</Title>
        </Group>
      </Stack>

      <Divider my="xs" />

      {userPaymentConfiguration?.tipaltiAccountStatus.toUpperCase() ===
        TipaltiStatus.PendingOnboarding ||
      userPaymentConfiguration?.tipaltiAccountStatus.toUpperCase() ===
        TipaltiStatus.InternalValue ? (
        <>
          <Stack>
            <Text>
              Your account requires setup. Click the button below to start/continue your setup
              process.
            </Text>
          </Stack>
        </>
      ) : userPaymentConfiguration?.tipaltiAccountStatus.toUpperCase() === TipaltiStatus.Active ? (
        <>
          {userPaymentConfiguration?.tipaltiPaymentsEnabled ? (
            <Text>
              Your account is set up and ready for withdrawals. Click below to make any adjustments
              to your Tipalti account settings.
            </Text>
          ) : (
            <Stack>
              <Text>
                Your account has been activated but you are still not able to withdraw. If you had a
                failed payment, Tipalti will mark the account as not payable until you fix the
                problem.
              </Text>

              <Text>
                If you have not had a failed payment, this might be due to document verification and
                validation. You will be notified once this changes.
              </Text>
              <Text>If you think this is an error, please contact support.</Text>
            </Stack>
          )}
        </>
      ) : (
        <Text>
          We are unable to setup your account so that you can withdraw funds. You may contact
          support if you think this is a mistake to get a better understanding of the issue.
        </Text>
      )}

      <Divider my="xs" />

      {![TipaltiStatus.Blocked, TipaltiStatus.BlockedByTipalti].some(
        (s) => s === userPaymentConfiguration?.tipaltiAccountStatus
      ) && (
        <Button
          component="a"
          href="/tipalti/setup"
          target="_blank"
          rel="nofollow noreferrer"
          classNames={{ label: 'text-white' }}
          fullWidth
        >
          Set up my Tipalti Account
        </Button>
      )}
    </>
  );
};

export function UserPaymentConfigurationCard() {
  const { userPaymentConfiguration, isLoading } = useUserPaymentConfiguration();

  if (!isLoading && !userPaymentConfiguration) {
    return null;
  }

  return (
    <Card withBorder id="payments">
      {isLoading && (
        <Stack>
          <Loader />
        </Stack>
      )}
      {userPaymentConfiguration?.stripeAccountId && <StripeConnectConfigurationCard />}
      {userPaymentConfiguration?.tipaltiAccountId && userPaymentConfiguration?.stripeAccountId && (
        <Divider my="xl" />
      )}
      {!userPaymentConfiguration?.tipaltiAccountId && <TipaltiConfigurationCard />}
    </Card>
  );
}
