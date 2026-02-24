import {
  ActionIcon,
  Button,
  Center,
  CloseButton,
  Group,
  Loader,
  Modal,
  Radio,
  Stack,
  Text,
} from '@mantine/core';

import { hideNotification, showNotification } from '@mantine/notifications';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { IconArrowLeft } from '@tabler/icons-react';
import produce from 'immer';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { AdminAttentionForm } from '~/components/Report/AdminAttentionForm';
import { ClaimForm } from '~/components/Report/ClaimForm';
import { ArticleNsfwForm, ImageNsfwForm, ModelNsfwForm } from '~/components/Report/NsfwForm';
import { OwnershipForm } from '~/components/Report/OwnershipForm';
import { TosViolationForm } from '~/components/Report/TosViolationForm';
import { useVoteForTags } from '~/components/VotableTags/votableTag.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { getDisplayName } from '~/utils/string-helpers';

const reports = [
  {
    reason: ReportReason.NSFW,
    label: 'Mature Content',
    Element: ModelNsfwForm,
    availableFor: [ReportEntity.Model],
  },
  {
    reason: ReportReason.NSFW,
    label: 'Mature Content',
    Element: ImageNsfwForm,
    availableFor: [ReportEntity.Image],
  },
  {
    reason: ReportReason.NSFW,
    label: 'Mature Content',
    Element: ArticleNsfwForm,
    availableFor: [
      ReportEntity.Article,
      ReportEntity.Post,
      ReportEntity.Collection,
      ReportEntity.Bounty,
      ReportEntity.BountyEntry,
      ReportEntity.ComicProject,
    ],
  },
  {
    reason: ReportReason.TOSViolation,
    label: 'TOS Violation',
    Element: TosViolationForm,
    availableFor: [
      ReportEntity.Model,
      ReportEntity.Comment,
      ReportEntity.CommentV2,
      ReportEntity.Image,
      ReportEntity.ResourceReview,
      ReportEntity.Article,
      ReportEntity.Post,
      ReportEntity.User,
      ReportEntity.Collection,
      ReportEntity.Bounty,
      ReportEntity.BountyEntry,
      ReportEntity.ComicProject,
    ],
  },
  {
    reason: ReportReason.AdminAttention,
    label: 'Needs Moderator Review',
    Element: AdminAttentionForm,
    availableFor: [
      ReportEntity.Model,
      ReportEntity.Comment,
      ReportEntity.CommentV2,
      ReportEntity.Image,
      ReportEntity.ResourceReview,
      ReportEntity.Article,
      ReportEntity.Post,
      ReportEntity.User,
      ReportEntity.Collection,
      ReportEntity.Bounty,
      ReportEntity.BountyEntry,
      ReportEntity.Chat,
      ReportEntity.ComicProject,
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
    availableFor: [ReportEntity.Model, ReportEntity.BountyEntry],
  },
];

const invalidateReasons = [ReportReason.NSFW, ReportReason.Ownership];
const SEND_REPORT_ID = 'sending-report';

export type ReportModalProps = {
  entityType: ReportEntity;
  entityId: number;
};

export default function ReportModal({
  entityType,
  entityId,
}: {
  entityType: ReportEntity;
  entityId: number;
}) {
  const dialog = useDialogContext();

  // #region [temp for gallery image reports]
  const router = useRouter();
  const modelId = router.query.modelId ? Number(router.query.modelId) : undefined;
  // #endregion

  //TODO - redirect if no user is authenticated
  const [reason, setReason] = useState<ReportReason>();
  const [uploading, setUploading] = useState(false);
  const ReportForm = useMemo(
    () =>
      reports.find((x) => x.reason === reason && x.availableFor.includes(entityType))?.Element ??
      null,
    [entityType, reason]
  );
  const title = useMemo(
    () =>
      reports.find((x) => x.reason === reason && x.availableFor.includes(entityType))?.label ??
      `Report ${getDisplayName(entityType)}`,
    [reason, entityType]
  );
  const handleVote = useVoteForTags({ entityType: entityType as 'image' | 'model', entityId });

  const queryUtils = trpc.useUtils();
  const { data, isInitialLoading } = trpc.model.getModelReportDetails.useQuery(
    { id: entityId },
    { enabled: entityType === ReportEntity.Model }
  );
  const { mutate, isLoading: isLoading } = trpc.report.create.useMutation({
    onMutate() {
      showNotification({
        id: SEND_REPORT_ID,
        loading: true,
        withCloseButton: false,
        autoClose: false,
        message: 'Sending report...',
      });
    },
    async onSuccess(_, variables) {
      showSuccessNotification({
        title: 'Resource reported',
        message: 'Your request has been received',
      });
      dialog.onClose();
      if (invalidateReasons.some((reason) => reason === variables.reason)) {
        switch (entityType) {
          case ReportEntity.Model:
            queryUtils.model.getById.setData(
              { id: variables.id },
              produce((old) => {
                if (old) {
                  if (variables.reason === ReportReason.NSFW) {
                    // old.nsfw = true; // don't think this is used anywhere
                  } else if (variables.reason === ReportReason.Ownership) {
                    old.reportStats = { ...old.reportStats, ownershipProcessing: 1 };
                  }
                }
              })
            );
            await queryUtils.model.getAll.invalidate();
            break;

          case ReportEntity.Image:
            if (variables.reason === ReportReason.NSFW) {
              const { tags } = variables.details;
              if (tags) handleVote({ tags, vote: 1 });
            }
            // // model invalidate
            // if (modelId) {
            //   await queryUtils.model.getAll.invalidate();
            // }
            break;
          case ReportEntity.Article:
            if (variables.reason === ReportReason.NSFW) {
              queryUtils.article.getById.setData(
                { id: variables.id },
                produce((old) => {
                  // if (old) old.nsfw = true; // don't think this is used anywhere
                })
              );
            }
            await queryUtils.article.getInfinite.invalidate();
            break;
          case ReportEntity.Bounty:
            if (variables.reason === ReportReason.NSFW) {
              queryUtils.bounty.getById.setData(
                { id: variables.id },
                produce((old) => {
                  // if (old) old.nsfw = true; // don't think this is used anywhere
                })
              );
            }
            await queryUtils.bounty.getInfinite.invalidate();
            break;
          // Nothing changes here so nothing to invalidate...
          case ReportEntity.Comment:
          case ReportEntity.CommentV2:
          default:
            break;
        }
      }
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: error.message ?? 'An unexpected error occurred, please try again',
      });
    },
    onSettled() {
      hideNotification(SEND_REPORT_ID);
    },
  });

  const handleSubmit = (data: Record<string, unknown>) => {
    const details: any = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null));
    if (!reason) return;
    mutate({
      type: entityType,
      reason,
      id: entityId,
      details,
    });
  };

  const currentUser = useCurrentUser();
  useEffect(() => {
    if (currentUser) return;
    router.push(getLoginLink({ returnUrl: router.asPath, reason: 'report-content' }));
    dialog.onClose();
  }, [currentUser]);

  return (
    <Modal {...dialog} classNames={{ body: 'p-5' }} withCloseButton={false}>
      <Stack>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={4}>
            {!!reason && (
              <LegacyActionIcon onClick={() => setReason(undefined)}>
                <IconArrowLeft size={16} />
              </LegacyActionIcon>
            )}
            <Text>{title}</Text>
          </Group>
          <CloseButton onClick={dialog.onClose} />
        </Group>
        {isInitialLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : (
          !reason && (
            <Radio.Group
              value={reason}
              onChange={(reason) => setReason(reason as ReportReason)}
              // label="Report reason"
            >
              <Stack pb="xs">
                {reports
                  .filter(({ availableFor }) => availableFor.includes(entityType))
                  .filter((item) => {
                    if (entityType === ReportEntity.Model) {
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
              </Stack>
            </Radio.Group>
          )
        )}
        {ReportForm && (
          <ReportForm onSubmit={handleSubmit} setUploading={setUploading}>
            <Group grow>
              <Button variant="default" onClick={dialog.onClose}>
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
}
