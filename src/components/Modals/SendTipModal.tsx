import {
  ActionIcon,
  Box,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import { IconBolt, IconSend } from '@tabler/icons-react';
import React, { useState } from 'react';
import { z } from 'zod';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputNumber, useForm } from '~/libs/form';
import { TransactionType } from '~/server/schema/buzz.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  presetCard: {
    position: 'relative',
    width: '100%',
    borderRadius: theme.radius.sm,
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,

    '&:hover:not([disabled])': {
      borderColor: theme.colors.blue[6],
    },

    '&[disabled]': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },

  sendIcon: {
    backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
    color: theme.white,
    borderTopRightRadius: theme.radius.sm,
    borderBottomRightRadius: theme.radius.sm,
  },
}));

const schema = z.object({
  amount: z.number().positive().min(1),
});

const presets = [
  { label: 'Small', amount: 500 },
  { label: 'Medium', amount: 2000 },
  { label: 'Hefty', amount: 10000 },
];

const { openModal, Modal } = createContextModal<{ toUserId: number }>({
  name: 'sendTip',
  title: 'Send Tip',
  centered: true,
  Element: ({ context, props: { toUserId } }) => {
    const { classes } = useStyles();
    const currentUser = useCurrentUser();
    const form = useForm({ schema });
    const queryUtils = trpc.useContext();

    const [loading, setLoading] = useState(false);

    const createBuzzTransactionMutation = trpc.buzz.createTransaction.useMutation({
      async onSuccess(_, { amount }) {
        setLoading(false);

        await queryUtils.buzz.getUserAccount.cancel();
        queryUtils.buzz.getUserAccount.setData(undefined, (old) =>
          old
            ? {
                ...old,
                balance: amount <= old.balance ? old.balance - amount : old.balance,
              }
            : old
        );

        handleClose();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to send tip',
          error: new Error(error.message),
        });
      },
    });

    const handleClose = () => context.close();
    const handleSubmit = ({ amount }: z.infer<typeof schema>) => {
      createBuzzTransactionMutation.mutate({
        toAccountId: toUserId,
        type: TransactionType.Tip,
        amount,
      });
    };

    const sending = loading || createBuzzTransactionMutation.isLoading;

    return (
      <Stack spacing="xl">
        <Divider label="Choose a preset" />
        <Group spacing="md">
          {presets.map((preset) => (
            <UnstyledButton
              key={preset.label}
              className={classes.presetCard}
              disabled={loading}
              onClick={() => {
                setLoading(true);
                handleSubmit({ amount: preset.amount });
              }}
            >
              <Group noWrap>
                <Group spacing="xs" p="xl" noWrap>
                  <IconBolt />
                  <Text>Send {preset.amount.toLocaleString()} buzz</Text>
                </Group>
                <Box className={classes.sendIcon} h="100%" ml="auto" p="xl">
                  <IconSend />
                </Box>
              </Group>
            </UnstyledButton>
          ))}
        </Group>
        <Divider label="or a custom amount" />
        <Form form={form} onSubmit={handleSubmit}>
          <InputNumber
            name="amount"
            placeholder="Your tip"
            icon={<IconBolt size={18} />}
            rightSectionWidth="10%"
            min={1}
            max={currentUser?.balance}
            disabled={sending}
            parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
            formatter={(value) =>
              value && !Number.isNaN(parseFloat(value))
                ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                : ''
            }
            rightSection={
              createBuzzTransactionMutation.isLoading ? (
                <Loader size="xs" />
              ) : (
                <ActionIcon
                  variant="filled"
                  color="blue"
                  type="submit"
                  w="100%"
                  h="100%"
                  disabled={sending}
                >
                  <IconSend size={20} />
                </ActionIcon>
              )
            }
            hideControls
          />
        </Form>
      </Stack>
    );
  },
});

export const openSendTipModal = openModal;
export default Modal;
