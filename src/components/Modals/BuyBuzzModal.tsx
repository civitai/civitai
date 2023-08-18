import {
  Button,
  Card,
  Center,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { Price } from '@prisma/client';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';

const useStyles = createStyles((theme) => ({
  buzzPreset: {
    ...theme.fn.focusStyles(),
    cursor: 'pointer',

    '&:hover': {
      borderColor: theme.colors.blue[6],
    },
  },

  selected: {
    borderColor: theme.colors.blue[6],
  },

  priceBanner: {
    backgroundColor: theme.colors.blue[6],
  },
}));

type SelectablePackage = Pick<Price, 'id' | 'unitAmount' | 'description'>;

const { openModal, Modal } = createContextModal<{ message?: string }>({
  name: 'buyBuzz',
  title: 'Buy Buzz',
  size: 'lg',
  Element: ({ context, props: { message } }) => {
    const currentUser = useCurrentUser();
    const { classes, cx } = useStyles();
    const router = useRouter();

    const [selectedPackage, setSelectedPackage] = useState<SelectablePackage | null>(null);
    const [customMessage, setCustomMessage] = useState<string>(message ?? '');

    const { data = [], isLoading } = trpc.stripe.getBuzzPackages.useQuery();
    const createBuzzSessionMutation = trpc.stripe.createBuzzSession.useMutation();

    const handleClose = () => context.close();
    const handleSubmit = () => {
      if (selectedPackage) {
        createBuzzSessionMutation.mutate(
          { priceId: selectedPackage.id, returnUrl: location.href },
          {
            onSuccess: async ({ url, sessionId }) => {
              if (url) await router.push(url);
              else {
                const stripe = await getClientStripe();
                await stripe.redirectToCheckout({ sessionId });
              }
            },
            onError: (error) => {
              showErrorNotification({
                title: 'Could not process purchase',
                error: new Error(error.message),
              });
            },
          }
        );
      }
    };

    return (
      <Stack spacing="xl">
        {customMessage && (
          <AlertWithIcon icon={<IconInfoCircle />} iconSize="md">
            {customMessage}
          </AlertWithIcon>
        )}
        <SimpleGrid
          breakpoints={[
            { minWidth: 'xs', cols: 1 },
            { minWidth: 'md', cols: 3 },
          ]}
          spacing="sm"
        >
          {isLoading
            ? Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} width="100%" height={250} />
              ))
            : data.map((buzzPackage) => {
                if (!buzzPackage.unitAmount) return null;

                const price = (buzzPackage.unitAmount ?? 0) / 100;

                return (
                  <Card
                    component="button"
                    key={buzzPackage.id}
                    className={cx(classes.buzzPreset, {
                      [classes.selected]: selectedPackage?.id === buzzPackage.id,
                    })}
                    onClick={() => setSelectedPackage(buzzPackage)}
                    withBorder
                  >
                    <Stack align="center" mb="xs">
                      <ThemeIcon size="xl" radius="xl">
                        <IconBolt />
                      </ThemeIcon>
                      <Stack spacing={0}>
                        <Text size="lg" align="center">
                          {buzzPackage.buzzAmount ? buzzPackage.buzzAmount.toLocaleString() : 0}
                        </Text>
                        <Text size="lg" align="center">
                          {buzzPackage.description ?? 'Buzz'}
                        </Text>
                      </Stack>
                    </Stack>
                    <Card.Section className={classes.priceBanner} py="xs" withBorder inheritPadding>
                      <Center>
                        <Text color="white" weight="bold" align="center">
                          {`$${price.toFixed(2)}`}
                        </Text>
                      </Center>
                    </Card.Section>
                  </Card>
                );
              })}
        </SimpleGrid>
        <Group position="right">
          <Button variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={createBuzzSessionMutation.isLoading}>
            Buy
          </Button>
        </Group>
      </Stack>
    );
  },
});

export const openBuyBuzzModal = openModal;
export default Modal;
