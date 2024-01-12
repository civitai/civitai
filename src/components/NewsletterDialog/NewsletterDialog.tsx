import { Button, Dialog, Group, Image, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Form, InputText, useForm } from '~/libs/form';
import {
  updateSubscriptionSchema,
  UpdateSubscriptionSchema,
} from '~/server/schema/newsletter.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function NewsletterDialog() {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(true);

  const form = useForm({
    schema: updateSubscriptionSchema,
    defaultValues: { email: undefined, subscribed: true },
  });

  const {
    data: subscription,
    isLoading,
    refetch,
  } = trpc.newsletter.getSubscription.useQuery(undefined, { enabled: false });

  const updateNewsletterSubscriptionMutation = trpc.newsletter.updateSubscription.useMutation({
    async onSuccess() {
      await queryUtils.newsletter.getSubscription.invalidate();
      setOpened(false);
      form.reset();
    },
    onError() {
      showErrorNotification({
        title: 'Failed to subscribe to newsletter',
        error: new Error('An unknown error occurred. Please try again later.'),
      });
    },
  });
  const handleSubscribe = (data: UpdateSubscriptionSchema) => {
    updateNewsletterSubscriptionMutation.mutate(data);
  };

  const postponeNewsletterDialogMutation = trpc.newsletter.postpone.useMutation();
  const handleClose = () => {
    if (currentUser) postponeNewsletterDialogMutation.mutate();
    return setOpened(false);
  };

  console.log({
    subscription,
    isLoading,
    opened,
    condition:
      opened && !(isLoading || subscription?.subscribed) && !!subscription?.showNewsletterDialog,
  });

  useEffect(() => {
    setTimeout(() => refetch(), 30000);
    // We just want to run this once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog
      size={mobile ? 'calc(85vw)' : 'lg'}
      transition="slide-left"
      radius="md"
      shadow="lg"
      p={0}
      position={{ bottom: 10, right: 10 }}
      opened={
        opened && !(isLoading || subscription?.subscribed) && !!subscription?.showNewsletterDialog
      }
      onClose={handleClose}
      styles={{ closeButton: { zIndex: 2 } }}
      withCloseButton
    >
      <Image
        src="/images/newsletter-banner.png"
        alt="Robot holding a newspaper"
        styles={{
          root: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            opacity: 0.3,
            height: '100%',
            width: '80% !important',
            padding: 8,
            transform: 'translate(-50%,-50%)',
          },
          figure: { height: '100%' },
          imageWrapper: { height: '100%' },
        }}
        imageProps={{
          style: {
            objectPosition: 'top',
            width: '100%',
            objectFit: 'cover',
          },
        }}
      />
      <Stack spacing="md" p="md">
        <Stack spacing={4} sx={{ zIndex: 10 }}>
          <Text size="md" weight={600}>
            Stay in the loop!
          </Text>
          <Text size="sm" lh={1.1}>
            Sign up for the Civitai Newsletter! Biweekly updates on industry news, new Civitai
            features, trending resources, community contests, and more!
          </Text>
        </Stack>

        <Form form={form} onSubmit={handleSubscribe}>
          <Group spacing={8} align="flex-end">
            {!currentUser && (
              <InputText
                placeholder="hello@civitai.com"
                name="email"
                error=""
                style={{ flex: 1 }}
              />
            )}
            <InputText name="subscribed" type="hidden" style={{ display: 'none' }} hidden />
            <Button type="submit" loading={updateNewsletterSubscriptionMutation.isLoading}>
              Subscribe
            </Button>
          </Group>
        </Form>
      </Stack>
    </Dialog>
  );
}
