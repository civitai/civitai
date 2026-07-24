import {
  Alert,
  Button,
  CloseButton,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { SupportContent } from '~/components/Support/SupportContent';
import { banReasonDetails } from '~/server/common/constants';
import { BanReasonCode } from '~/server/common/enums';
import { numberWithCommas } from '~/utils/number-helpers';
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
  // Unpublishing models happens on every ban historically, so default it on.
  // Blocking media defaults on only for SexualMinor (kept in sync as the reason
  // changes, but a mod can still override either toggle).
  const [removeModels, setRemoveModels] = useState(true);
  const [removeMedia, setRemoveMedia] = useState(false);

  const { data: banPreview } = trpc.user.getBanContentPreview.useQuery({ userId });
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

    toggleBanMutation.mutate({
      id: userId,
      reasonCode,
      detailsInternal,
      detailsExternal,
      removeModels,
      removeMedia,
    });
  };

  const handleReasonChange = (value: string | null) => {
    const nextReason = value as BanReasonCode;
    setReasonCode(nextReason);
    setRemoveMedia(nextReason === BanReasonCode.SexualMinor);
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
          onChange={handleReasonChange}
          withAsterisk
        />

        <Stack gap="sm">
          <Switch
            label="Unpublish all models"
            description={
              banPreview
                ? `Unpublishes this user's ${numberWithCommas(
                    banPreview.modelCount
                  )} published model${banPreview.modelCount === 1 ? '' : 's'}.`
                : 'Unpublishes all of this user’s published models.'
            }
            checked={removeModels}
            onChange={(event) => setRemoveModels(event.currentTarget.checked)}
          />
          <Switch
            label="Remove all images & videos"
            description={
              banPreview
                ? `Blocks this user's ${numberWithCommas(banPreview.imageCount)} image${
                    banPreview.imageCount === 1 ? '' : 's'
                  } & videos (7-day appeal window, then deleted).`
                : 'Blocks all of this user’s images & videos.'
            }
            checked={removeMedia}
            onChange={(event) => setRemoveMedia(event.currentTarget.checked)}
          />
          {banPreview && (removeModels || removeMedia) && (
            <Alert color="red" p="xs" icon={<IconAlertTriangle size={18} />}>
              {[
                removeModels
                  ? `${numberWithCommas(banPreview.modelCount)} model${
                      banPreview.modelCount === 1 ? '' : 's'
                    }`
                  : null,
                removeMedia
                  ? `${numberWithCommas(banPreview.imageCount)} image${
                      banPreview.imageCount === 1 ? '' : 's'
                    } & videos`
                  : null,
              ]
                .filter(Boolean)
                .join(' and ')}{' '}
              will be removed on ban.
            </Alert>
          )}
        </Stack>

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
          <Button color="red" onClick={handleBan} loading={toggleBanMutation.isPending}>
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
