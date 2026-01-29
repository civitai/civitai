import { Button, CloseButton, Group, Modal, Select, Stack, Text, Title } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { SupportContent } from '~/components/Support/SupportContent';
import { banReasonDetails } from '~/server/common/constants';
import { BanReasonCode } from '~/server/common/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = {
  userId: number;
  username: string;
  onSuccess?: () => void;
};

export default function UserBanModal({ username, userId, onSuccess }: Props) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();
  const [reasonCode, setReasonCode] = useState<BanReasonCode>(BanReasonCode.Other);
  const [detailsInternal, setDetailsInternal] = useState<string | undefined>('');
  const [detailsExternal, setDetailsExternal] = useState<string | undefined>('');
  const dataLabels = useMemo(() => {
    return Object.keys(BanReasonCode).map((r) => {
      const data = banReasonDetails[r as BanReasonCode];
      return {
        value: r,
        label: data.privateBanReasonLabel ? `${r}: ${data.privateBanReasonLabel}` : r,
      };
    });
  }, []);

  const toggleBanMutation = trpc.user.toggleBan.useMutation({
    async onMutate() {
      await queryUtils.user.getCreator.cancel({ username });

      const prevUser = queryUtils.user.getCreator.getData({ username });
      queryUtils.user.getCreator.setData({ username }, () =>
        prevUser
          ? {
              ...prevUser,
              bannedAt: prevUser.bannedAt ? null : new Date(),
            }
          : undefined
      );

      return { prevUser };
    },
    async onSuccess() {
      await queryUtils.userProfile.get.invalidate({ username });
      onSuccess?.();
      dialog.onClose();
    },
    onError(_error, _vars, context) {
      queryUtils.user.getCreator.setData({ username }, context?.prevUser);
      showErrorNotification({
        error: new Error('Unable to ban user, please try again.'),
      });
    },
  });

  const handleBan = () => {
    if (reasonCode === 'Other' && !detailsInternal) {
      showErrorNotification({
        error: new Error('Please provide internal details for banning this user.'),
      });
      return;
    }

    toggleBanMutation.mutate({ id: userId, reasonCode, detailsInternal, detailsExternal });
  };

  return (
    <Modal {...dialog} size="md" withCloseButton={false} centered>
      <Stack gap={32}>
        <Group align="flex-start" justify="space-between" gap="xs" wrap="nowrap">
          <Title order={4} className="text-gray-1">
            Are you sure you want to ban this user?
          </Title>
          <CloseButton aria-label="Close support modal" size="md" onClick={dialog.onClose} />
        </Group>

        <Text>
          Once a user is banned, they won&rsquo;t be able to access the app again. Be sure to
          provide a relevant reason to ban this user below.
        </Text>

        <Select
          label="Ban Reason"
          placeholder="Select a ban reason"
          data={dataLabels}
          value={reasonCode}
          onChange={(value) => setReasonCode(value as BanReasonCode)}
          withAsterisk
        />

        <RichTextEditor
          label="Internal Details"
          description="Provide an explanation for banning this user. This will NOT be visible to the user."
          value={detailsInternal}
          includeControls={['formatting']}
          onChange={(value) => setDetailsInternal(value)}
          hideToolbar
          withAsterisk={reasonCode === BanReasonCode.Other}
        />
        <RichTextEditor
          label="Public Details"
          description="Provide an explanation for banning this user. This will be visible to the banned user."
          value={detailsExternal}
          includeControls={['formatting']}
          onChange={(value) => setDetailsExternal(value)}
          hideToolbar
        />

        <Stack gap="xs">
          <Button color="red" onClick={handleBan} loading={toggleBanMutation.isLoading}>
            Ban this user
          </Button>
          <Button color="gray" onClick={dialog.onClose}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}
