import { Button, Dialog, Group, Image, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import {
  updateSubscriptionSchema,
  UpdateSubscriptionSchema,
} from '~/server/schema/newsletter.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { increaseDate } from '~//utils/date-helpers';
import styles from './NewsletterDialog.module.scss';

const REFETCH_TIMEOUT = 30000; // 30 seconds

export function NewsletterDialog() {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();

  const [opened, setOpened] = useState(true);
  const [postponedUntil, setPostponedUntil] = useLocalStorage<string | null>({
    key: 'newsletterDialogPostponedUntil',
    defaultValue: null,
  });

  const form = useForm({
    schema: updateSubscriptionSchema,
    defaultValues: { email: currentUser?.email ?? '', subscribed: true },
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
    setPostponedUntil(increaseDate(new Date(), 7, 'days').toISOString());
    setOpened(false);
    return;
  };

  useEffect(() => {
    setTimeout(() => refetch(), REFETCH_TIMEOUT);
    // We just want to run this once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const postponedExpired = !postponedUntil || new Date(postponedUntil) <= new Date();

  return (
    <Dialog
      transition="slide-left"
      radius="md"
      shadow="lg"
      p={0}
      classNames={{ root: styles.dialogRoot }}
      position={{ bottom: 10, right: 10 }}
      opened={opened && !isLoading && !!subscription?.showNewsletterDialog && postponedExpired}
      onClose={handleClose}
      withCloseButton
    >
      <Image
        src="/images/newsletter-banner.png"
        alt="Robot holding a newspaper"
        classNames={{
          root: styles.bannerRoot,
          figure: styles.bannerFigure,
          imageWrapper: styles.bannerImageWrapper,
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
        <Stack spacing={4}>
          <Text size="md" weight={600}>
            Stay in the loop!
          </Text>
          <Text size="sm" lh={1.1}>
            Sign up for the Civitai Newsletter! Biweekly updates on industry news, new Civitai
            features, trending resources, community contests, and more!
          </Text>
        </Stack>

        <Form form={form} onSubmit={handleSubscribe}>
          <Group spacing={8} align="flex-start" position="right">
            <InputText
              placeholder="hello@civitai.com"
              name="email"
              type={currentUser ? 'hidden' : undefined}
              hidden={!!currentUser}
              style={{ flex: 1 }}
            />
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

