import { Button, Group, Modal, Radio, Stack, Text, CloseButton, ActionIcon } from '@mantine/core';

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

const reports = [
  {
    reason: ReportReason.NSFW,
    label: 'NSFW',
    Element: NsfwForm,
    availableFor: [ReportEntity.Model, ReportEntity.Review],
  },
  {
    reason: ReportReason.TOSViolation,
    label: 'TOS Violation',
    Element: TosViolationForm,
    availableFor: [ReportEntity.Model, ReportEntity.Review, ReportEntity.Comment],
  },
  {
    reason: ReportReason.AdminAttention,
    label: 'Needs Moderator Review',
    Element: AdminAttentionForm,
    availableFor: [ReportEntity.Model, ReportEntity.Review, ReportEntity.Comment],
  },
  {
    reason: ReportReason.Claim,
    label: 'Claim imported model',
    Element: ClaimForm,
    availableFor: [ReportEntity.Model],
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
  schema: z.object({
    type: z.nativeEnum(ReportEntity),
    entityId: z.number(),
  }),
  Element: ({ context, props: { type, entityId } }) => {
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
    const { mutate, isLoading } = trpc.report.create.useMutation({
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
                      old.reportStats = { ...old.reportStats, ownershipPending: 1 };
                    }
                  }
                })
              );
              await queryUtils.model.getAll.invalidate();
              break;
            case ReportEntity.Review:
              await queryUtils.comment.getById.invalidate({ id: variables.id });
              await queryUtils.comment.getAll.invalidate();
              break;
            case ReportEntity.Comment:
              await queryUtils.review.getDetail.invalidate({ id: variables.id });
              await queryUtils.comment.getAll.invalidate();
              await queryUtils.comment.getCommentsById.invalidate();
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
          {!reason && (
            <Radio.Group
              orientation="vertical"
              value={reason}
              onChange={(reason) => setReason(reason as ReportReason)}
              // label="Report reason"
              pb="xs"
            >
              {reports
                .filter(({ availableFor }) => availableFor.includes(type))
                .map(({ reason, label }, index) => (
                  <Radio key={index} value={reason} label={label} />
                ))}
            </Radio.Group>
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
