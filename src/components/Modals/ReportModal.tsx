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
import { SpamForm } from '~/components/Report/SpamForm';
import { TosViolationForm } from '~/components/Report/TosViolationForm';
import { useVoteForTags } from '~/components/VotableTags/votableTag.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { getDisplayName } from '~/utils/string-helpers';
import { StickerPlacementForm } from '~/components/Report/StickerPlacementForm';
import { ReportTargetProvider } from '~/components/Report/report-target.context';

const reports = [
  {
    key: 'nsfw-model',
    reason: ReportReason.NSFW,
    label: 'Mature Content',
    Element: ModelNsfwForm,
    availableFor: [ReportEntity.Model],
  },
  {
    key: 'nsfw-image',
    reason: ReportReason.NSFW,
    label: 'Mature Content',
    Element: ImageNsfwForm,
    availableFor: [ReportEntity.Image],
  },
  {
    key: 'nsfw-article',
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
      ReportEntity.Model3D,
    ],
  },
  {
    key: 'tos',
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
      ReportEntity.Model3D,
      ReportEntity.Model3DReview,
      ReportEntity.Challenge,
    ],
  },
  {
    key: 'admin-attention',
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
      ReportEntity.Model3D,
      ReportEntity.Model3DReview,
      ReportEntity.Challenge,
    ],
  },
  {
    key: 'claim',
    reason: ReportReason.Claim,
    label: 'Claim imported model',
    Element: ClaimForm,
    availableFor: [ReportEntity.Model], // TODO only available if model creator/userId === -1
  },
  {
    key: 'ownership',
    reason: ReportReason.Ownership,
    label: 'This uses my art',
    Element: OwnershipForm,
    availableFor: [ReportEntity.Model, ReportEntity.BountyEntry, ReportEntity.Challenge],
  },
  {
    // Its own reason, not TOSViolation. Reports dedupe on (reason, entityId), so
    // sharing one folds every sticker report into whatever TOS report the image
    // already had and discards its details — including the placement id the
    // report exists to carry.
    key: 'sticker-placement',
    reason: ReportReason.StickerPlacement,
    // Never rendered in the reason list — this entry is reachable only from the
    // flag on a sticker — so the label is the modal's title and nothing else.
    label: 'Report this sticker',
    Element: StickerPlacementForm,
    availableFor: [ReportEntity.Image],
  },
  {
    key: 'spam',
    reason: ReportReason.Spam,
    label: 'Spam',
    Element: SpamForm,
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
      ReportEntity.Model3D,
      ReportEntity.Model3DReview,
      ReportEntity.Challenge,
    ],
  },
];

const invalidateReasons = [ReportReason.NSFW, ReportReason.Ownership];
const SEND_REPORT_ID = 'sending-report';

export type ReportModalProps = {
  entityType: ReportEntity;
  entityId: number;
  /**
   * Open straight onto one form instead of the reason list.
   *
   * For a report that starts from the thing being reported rather than from the
   * page it sits on: the flag on a sticker already knows the reason and the
   * sticker, so a list of reasons is a question with one answer.
   */
  reportKey?: string;
  /** The placement the flag was on, when the report started there. */
  placementId?: number;
  /** Which half of that placement the flag was on. */
  placementTarget?: 'sticker' | 'comment';
};

export default function ReportModal({
  entityType,
  entityId,
  reportKey: initialReportKey,
  placementId,
  placementTarget,
}: ReportModalProps) {
  const dialog = useDialogContext();

  // #region [temp for gallery image reports]
  const router = useRouter();
  const modelId = router.query.modelId ? Number(router.query.modelId) : undefined;
  // #endregion

  //TODO - redirect if no user is authenticated
  // Selected by `key`, not by reason. Two entries can legitimately share a
  // reason — "Bad sticker placement" is a TOS violation delivered through a
  // sticker — and keying on the reason silently resolved to whichever was
  // declared first, so picking the sticker option ran the generic TOS form and
  // filed a report with no placement id in it.
  const [reportKey, setReportKey] = useState<string | undefined>(initialReportKey);
  const [uploading, setUploading] = useState(false);
  const selected = useMemo(
    () => reports.find((x) => x.key === reportKey && x.availableFor.includes(entityType)) ?? null,
    [entityType, reportKey]
  );
  const reason = selected?.reason;
  const ReportForm = selected?.Element ?? null;
  const title =
    selected?.key === 'sticker-placement' && placementTarget === 'comment'
      ? 'Report this note'
      : selected?.label ?? `Report ${getDisplayName(entityType)}`;
  const handleVote = useVoteForTags({ entityType: entityType as 'image' | 'model', entityId });

  const queryUtils = trpc.useUtils();
  const { data, isInitialLoading } = trpc.model.getModelReportDetails.useQuery(
    { id: entityId },
    { enabled: entityType === ReportEntity.Model }
  );
  const { mutate, isPending: isLoading } = trpc.report.create.useMutation({
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
          case ReportEntity.Model3D:
            if (variables.reason === ReportReason.NSFW) {
              queryUtils.model3d.getById.setData(
                { id: variables.id },
                produce((old) => {
                  if (old) old.nsfw = true;
                })
              );
            }
            await queryUtils.model3d.getInfinite.invalidate();
            break;
          case ReportEntity.Model3DReview:
            await queryUtils.model3d.reviews.getInfinite.invalidate();
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
            {/* No way back when the reason arrived with the modal: the list
                behind it was never shown, so "back" would land on a choice the
                reporter did not make. */}
            {!!selected && !initialReportKey && (
              <LegacyActionIcon onClick={() => setReportKey(undefined)}>
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
          !selected && (
            <Radio.Group
              value={reportKey}
              onChange={setReportKey}
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
                    // Reachable only from the flag on the sticker itself, never
                    // from the image. Offered here it would have to ask which
                    // sticker, and several copies of one sticker on an image are
                    // indistinguishable in a list — the guess a moderator then
                    // acts on is what the flag exists to remove.
                    if (item.reason === ReportReason.StickerPlacement) return false;
                    return true;
                  }) // TEMP FIX
                  .map(({ key, label }) => (
                    <Radio key={key} value={key} label={label} />
                  ))}
              </Stack>
            </Radio.Group>
          )
        )}
        {ReportForm && (
          <ReportTargetProvider value={{ entityType, entityId, placementId, placementTarget }}>
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
          </ReportTargetProvider>
        )}
      </Stack>
    </Modal>
  );
}
