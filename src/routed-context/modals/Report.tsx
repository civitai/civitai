import {
  Button,
  Group,
  Modal,
  Radio,
  Stack,
  Text,
  CloseButton,
  ActionIcon,
  Loader,
  Center,
} from '@mantine/core';

import { showNotification, hideNotification } from '@mantine/notifications';
import { ReportReason } from '@prisma/client';
import { IconArrowLeft } from '@tabler/icons';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { AdminAttentionForm } from '~/components/Report/AdminAttentionForm';
import { ClaimForm } from '~/components/Report/ClaimForm';
import { NsfwForm } from '~/components/Report/NsfwForm';
import { OwnershipForm } from '~/components/Report/OwnershipForm';
import { TosViolationForm } from '~/components/Report/TosViolationForm';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { ReportEntity } from '~/server/schema/report.schema';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { useRouter } from 'next/router';
import { useImageStore } from '~/store/images.store';

const reports = [
  {
    reason: ReportReason.NSFW,
    label: 'NSFW',
    Element: NsfwForm,
    availableFor: [ReportEntity.Model, ReportEntity.Review, ReportEntity.Image],
  },
  {
    reason: ReportReason.TOSViolation,
    label: 'TOS Violation',
    Element: TosViolationForm,
    availableFor: [
      ReportEntity.Model,
      ReportEntity.Review,
      ReportEntity.Comment,
      ReportEntity.Image,
    ],
  },
  {
    reason: ReportReason.AdminAttention,
    label: 'Needs Moderator Review',
    Element: AdminAttentionForm,
    availableFor: [
      ReportEntity.Model,
      ReportEntity.Review,
      ReportEntity.Comment,
      ReportEntity.Image,
    ],
  },
  {
    reason: ReportReason.Claim,
    label: 'Claim imported model',
    Element: ClaimForm,
    availableFor: [ReportEntity.Model], // TODO only available if model creator/userId === -1
  },
  {
    reason: ReportReason.Ownership,
    label: 'This uses my art',
    Element: OwnershipForm,
    availableFor: [ReportEntity.Model],
  },
];

const invalidateReasons = [ReportReason.NSFW, ReportReason.Ownership];
const SEND_REPORT_ID = 'sending-report';

export default createRoutedContext({
  authGuard: true,
  schema: z.object({
    type: z.nativeEnum(ReportEntity),
    entityId: z.number(),
  }),
  Element: ({ context, props: { type, entityId } }) => {
    // #region [temp for gallery image reports]
    const router = useRouter();
    const modelId = router.query.modelId ? Number(router.query.modelId) : undefined;
    const reviewId = router.query.reviewId ? Number(router.query.reviewId) : undefined;
    const setImage = useImageStore((state) => state.setImage);
    // #endregion

    //TODO - redirect if no user is authenticated
    const [reason, setReason] = useState<ReportReason>();
    const [uploading, setUploading] = useState(false);
    const ReportForm = useMemo(
      () => reports.find((x) => x.reason === reason)?.Element ?? null,
      [reason]
    );
    const title = useMemo(
      () => reports.find((x) => x.reason === reason)?.label ?? `Report ${type}`,
      [reason, type]
    );

    const queryUtils = trpc.useContext();
    const { data, isInitialLoading } = trpc.model.getModelReportDetails.useQuery(
      { id: entityId },
      { enabled: type === ReportEntity.Model }
    );
    const { mutate, isLoading: isLoading } = trpc.report.create.useMutation({
      onMutate() {
        showNotification({
          id: SEND_REPORT_ID,
          loading: true,
          disallowClose: true,
          autoClose: false,
          message: 'Sending report...',
        });
      },
      async onSuccess(_, variables) {
        showSuccessNotification({
          title: 'Model reported',
          message: 'Your request has been received',
        });
        context.close();
        if (invalidateReasons.some((reason) => reason === variables.reason)) {
          switch (type) {
            case ReportEntity.Model:
              queryUtils.model.getById.setData(
                { id: variables.id },
                produce((old) => {
                  if (old) {
                    if (variables.reason === ReportReason.NSFW) {
                      old.nsfw = true;
                    } else if (variables.reason === ReportReason.Ownership) {
                      old.reportStats = { ...old.reportStats, ownershipProcessing: 1 };
                    }
                  }
                })
              );
              await queryUtils.model.getAll.invalidate();
              break;
            case ReportEntity.Review:
              await queryUtils.review.getDetail.invalidate({ id: variables.id });
              await queryUtils.review.getAll.invalidate();
              break;
            case ReportEntity.Comment:
              await queryUtils.comment.getById.invalidate({ id: variables.id });
              await queryUtils.comment.getAll.invalidate();
              await queryUtils.comment.getCommentsById.invalidate();
              break;
            case ReportEntity.Image:
              if (variables.reason === ReportReason.NSFW) {
                setImage({ id: variables.id, nsfw: true });
              }
              break;
            default:
              break;
          }
        }
      },
      onError(error) {
        showErrorNotification({
          error: new Error(error.message),
          title: 'Unable to send report',
          reason: 'An unexpected error occurred, please try again',
        });
      },
      onSettled() {
        hideNotification(SEND_REPORT_ID);
      },
    });

    const handleSubmit = (data: Record<string, unknown>) => {
      const details: any = Object.fromEntries(Object.entries(data).filter(([_, v]) => v != null));
      if (!reason) return;
      mutate({
        type,
        reason,
        id: entityId,
        details,
      });
    };

    return (
      <Modal opened={context.opened} onClose={context.close} withCloseButton={false}>
        <Stack>
          <Group position="apart" noWrap>
            <Group spacing={4}>
              {!!reason && (
                <ActionIcon onClick={() => setReason(undefined)}>
                  <IconArrowLeft size={16} />
                </ActionIcon>
              )}
              <Text>{title}</Text>
            </Group>
            <CloseButton onClick={context.close} />
          </Group>
          {isInitialLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : (
            !reason && (
              <Radio.Group
                orientation="vertical"
                value={reason}
                onChange={(reason) => setReason(reason as ReportReason)}
                // label="Report reason"
                pb="xs"
              >
                {reports
                  .filter(({ availableFor }) => availableFor.includes(type))
                  .filter((item) => {
                    if (type === ReportEntity.Model) {
                      if (item.reason === ReportReason.Claim) return data?.userId !== -1;
                      if (item.reason === ReportReason.Ownership) {
                        return !data?.reportStats?.ownershipPending;
                      }
                    }
                    return true;
                  }) // TEMP FIX
                  .map(({ reason, label }, index) => (
                    <Radio key={index} value={reason} label={label} />
                  ))}
              </Radio.Group>
            )
          )}
          {ReportForm && (
            <ReportForm onSubmit={handleSubmit} setUploading={setUploading}>
              <Group grow>
                <Button variant="default" onClick={context.close}>
                  Cancel
                </Button>
                <Button type="submit" loading={isLoading} disabled={uploading}>
                  Submit
                </Button>
              </Group>
            </ReportForm>
          )}
        </Stack>
      </Modal>
    );
  },
});
