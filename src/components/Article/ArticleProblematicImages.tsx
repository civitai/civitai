/**
 * Article Problematic Content Component
 *
 * Displays a detailed list of blocked/error images and text moderation issues
 * that are blocking an article from being published.
 */

import { Alert, Text, Stack, Group, Paper, Select, Button, Badge } from '@mantine/core';
import {
  IconX,
  IconExclamationCircle,
  IconFileText,
  IconShieldCheck,
  IconRefresh,
  IconRadar2,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useRescanArticle } from '~/hooks/useRescanArticle';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { browsingLevels, browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { articleImageActions } from './articleImageActions';

export type TextModerationIssue = {
  // Terminal-state reason the text pipeline produced an article-blocking result.
  kind: 'blocked' | 'failed' | 'expired' | 'canceled';
  status: EntityModerationStatus;
  retryCount: number;
  updatedAt: Date | null;
};

type BlockedImage = {
  id: number;
  url: string;
  ingestion: ImageIngestionStatus;
  blockedFor: string | null;
  nsfwLevelLocked: boolean;
};

type ErrorImage = {
  id: number;
  url: string;
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  failureClass: string | null;
  reason: string | null;
};

interface ArticleProblematicImagesProps {
  articleId: number;
  blockedImages: BlockedImage[];
  errorImages: ErrorImage[];
  textIssue?: TextModerationIssue | null;
  canOverride?: boolean;
  canRetry?: boolean;
  canRescan?: boolean;
}

// Human, class-aware cause for an image the scanner couldn't clear.
function errorImageCause(image: ErrorImage): string {
  if (image.ingestion === ImageIngestionStatus.NotFound)
    return 'Image couldn’t be loaded during scanning. Try Retry scan; if it keeps failing, re-upload the image.';
  switch (image.failureClass) {
    case 'transient':
      return 'Scanning failed, retrying automatically.';
    case 'permanent':
      return 'This image can’t be scanned (unsupported or corrupt) — replace it.';
    default:
      return image.reason || 'This image failed to scan.';
  }
}

/**
 * The "an override was already applied" STATUS, split out of `ImageOverrideControl`.
 *
 * 🔴 A STATUS IS NOT AN ACTION, AND WITHDRAWING THE ACTION MUST NOT WITHDRAW THE STATUS. While the
 * two lived in one component, gating that component on `remedy.offerOverride` hid the badge as well
 * — and the state it reports is reachable for exactly these images: `updateImageNsfwLevel` sets
 * `nsfwLevelLocked` without touching `ingestion`, so an image can be locked and still sit in this
 * list. The reader would then see a card whose override had already been applied, with nothing
 * saying so.
 */
function ImageOverriddenBadge() {
  return (
    <Badge color="green" variant="light" leftSection={<IconShieldCheck size={12} />}>
      Overridden
    </Badge>
  );
}

function ImageOverrideControl({ articleId, imageId }: { articleId: number; imageId: number }) {
  const queryUtils = trpc.useUtils();
  const [level, setLevel] = useState<string | null>(null);

  const { mutate, isPending } = trpc.article.resolveImageScan.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Image override applied' });
      await queryUtils.article.getScanStatus.invalidate({ id: articleId });
      await queryUtils.article.getById.invalidate({ id: articleId });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not override image',
      });
    },
  });

  return (
    <Group gap="xs" wrap="nowrap">
      <Select
        size="xs"
        placeholder="Set rating"
        value={level}
        onChange={setLevel}
        data={browsingLevels.map((l) => ({ value: String(l), label: browsingLevelLabels[l] }))}
        w={110}
      />
      <Button
        size="xs"
        variant="light"
        color="green"
        loading={isPending}
        disabled={!level}
        onClick={() => level && mutate({ articleId, imageId, nsfwLevel: Number(level) })}
      >
        Override
      </Button>
    </Group>
  );
}

function ImageRetryButton({ articleId, imageId }: { articleId: number; imageId: number }) {
  const queryUtils = trpc.useUtils();
  const { mutate, isPending } = trpc.article.rescanImage.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Image sent for rescan' });
      await queryUtils.article.getScanStatus.invalidate({ id: articleId });
      await queryUtils.article.getById.invalidate({ id: articleId });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not rescan image',
      });
    },
  });

  return (
    <Button
      size="xs"
      variant="light"
      color="blue"
      leftSection={<IconRefresh size={14} />}
      loading={isPending}
      onClick={() => mutate({ articleId, imageId })}
    >
      Retry scan
    </Button>
  );
}

function TextModerationSection({ issue }: { issue: TextModerationIssue }) {
  const isBlocked = issue.kind === 'blocked';
  const accentColor = isBlocked ? 'red' : 'yellow';
  const Icon = isBlocked ? IconX : IconExclamationCircle;

  const heading = isBlocked
    ? 'Text Content Blocked - Policy Violation'
    : 'Text Moderation Failed - Scan Error';

  const description = isBlocked
    ? 'Your article title and/or body was flagged as violating our Terms of Service. Please edit the content and resubmit.'
    : issue.kind === 'failed'
    ? 'Automated text scanning could not complete. This sometimes happens with very long articles or transient service issues.'
    : issue.kind === 'expired'
    ? 'The text scan timed out before completing. A rescan usually resolves this.'
    : 'The text scan was canceled before completing. A rescan usually resolves this.';

  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Icon size={16} className={isBlocked ? 'text-red-6' : 'text-yellow-6'} />
        <Text size="sm" fw={600}>
          {heading}
        </Text>
      </Group>
      <Paper
        p="xs"
        withBorder
        className={clsx('border-l-2', isBlocked ? 'border-l-red-6' : 'border-l-yellow-6')}
      >
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <div
            className={`flex size-16 shrink-0 items-center justify-center overflow-hidden rounded border ${
              isBlocked
                ? 'border-red-6 bg-red-2 dark:bg-red-9/40'
                : 'border-yellow-6 bg-yellow-2 dark:bg-yellow-9/40'
            }`}
          >
            <IconFileText size={28} className={isBlocked ? 'text-red-7' : 'text-yellow-7'} />
          </div>
          <Stack gap={4} className="flex-1">
            <Text size="xs" fw={500} c={`${accentColor}.7`}>
              {description}
            </Text>
            <Text size="xs" c="dimmed">
              Status: {issue.status}
              {issue.retryCount > 0 ? ` • Retries: ${issue.retryCount}` : ''}
            </Text>
          </Stack>
        </Group>
      </Paper>
    </Stack>
  );
}

export function ArticleProblematicImages({
  articleId,
  blockedImages,
  errorImages,
  textIssue,
  canOverride,
  canRetry,
  canRescan,
}: ArticleProblematicImagesProps) {
  const { rescan, isLoading: isRescanning } = useRescanArticle();
  const hasImageProblems = blockedImages.length > 0 || errorImages.length > 0;
  const hasTextProblem = !!textIssue;
  if (!hasImageProblems && !hasTextProblem) return null;

  const title =
    hasImageProblems && hasTextProblem
      ? 'Action Required - Problematic Content'
      : hasTextProblem
      ? 'Action Required - Text Moderation'
      : 'Action Required - Problematic Images';

  const leadText =
    hasImageProblems && hasTextProblem
      ? 'These content issues must be resolved before your article can be published'
      : hasTextProblem
      ? 'A text moderation issue is preventing your article from being published'
      : 'These images must be removed or replaced before your article can be published';

  return (
    <Alert title={title} color="red">
      <Stack gap="md">
        <Text size="sm">{leadText}</Text>

        {/* Text Moderation Section */}
        {textIssue && <TextModerationSection issue={textIssue} />}

        {/* Blocked Images Section */}
        {blockedImages.length > 0 && (
          <Stack gap="sm">
            <Group gap="xs">
              <IconX size={16} className="text-red-6" />
              <Text size="sm" fw={600}>
                Blocked Images ({blockedImages.length}) - Policy Violation
              </Text>
            </Group>
            <Stack gap="sm">
              {blockedImages.map((image) => {
                const remedy = articleImageActions(image.url);
                return (
                  <Paper key={image.id} p="xs" withBorder className="border-l-2 border-l-red-6">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div className="relative size-16 shrink-0 overflow-hidden rounded border border-red-6">
                          <EdgeMedia
                            src={image.url}
                            width={64}
                            className="size-full object-cover"
                            alt="Blocked image (removed for policy violation)"
                          />
                        </div>
                        <Stack gap={4} className="min-w-0 flex-1">
                          <Text size="xs" fw={500} c="red.7">
                            Blocked: {image.blockedFor || 'Policy violation'}
                          </Text>
                          {canOverride && (
                            <Text size="xs" c="dimmed">
                              ID: {image.id}
                            </Text>
                          )}
                          {/* The server refuses to publish this url whatever it is rated, so the note
                            replaces the control rather than sitting beside it. */}
                          {remedy.blockingNote && (
                            <Text size="xs" c="dimmed">
                              {remedy.blockingNote}
                            </Text>
                          )}
                        </Stack>
                      </div>
                      {canOverride && (remedy.offerOverride || image.nsfwLevelLocked) && (
                        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                          {canOverride && remedy.offerOverride && !image.nsfwLevelLocked && (
                            <ImageOverrideControl articleId={articleId} imageId={image.id} />
                          )}
                          {/* The STATUS survives the withdrawal of the action — see
                            ImageOverriddenBadge. */}
                          {canOverride && image.nsfwLevelLocked && <ImageOverriddenBadge />}
                        </div>
                      )}
                    </div>
                  </Paper>
                );
              })}
            </Stack>
          </Stack>
        )}

        {/* Error Images Section */}
        {errorImages.length > 0 && (
          <Stack gap="sm">
            <Group gap="xs">
              <IconExclamationCircle size={16} className="text-yellow-6" />
              <Text size="sm" fw={600}>
                Failed Images ({errorImages.length}) - Scan Error
              </Text>
            </Group>
            <Stack gap="sm">
              {errorImages.map((image) => {
                const remedy = articleImageActions(image.url);
                return (
                  <Paper key={image.id} p="xs" withBorder className="border-l-2 border-l-yellow-6">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div className="relative size-16 shrink-0 overflow-hidden rounded border border-yellow-6 bg-gray-1 dark:bg-gray-8">
                          <EdgeMedia
                            src={image.url}
                            width={64}
                            className="size-full object-cover"
                            alt="Error image (may be broken)"
                          />
                        </div>
                        <Stack gap={4} className="min-w-0 flex-1">
                          <Text size="xs" fw={500} c="yellow.7">
                            {remedy.blockingNote ?? errorImageCause(image)}
                          </Text>
                          {canOverride && (
                            <Text size="xs" c="dimmed">
                              ID: {image.id}
                            </Text>
                          )}
                        </Stack>
                      </div>
                      {/* Both ACTIONS are dead ends for an unrenderable url: Override calls the
                        mutation that refuses it, and Retry re-fetches a handle nothing outside the
                        originating document can read. The note above names the remedy instead. The
                        Overridden BADGE is not an action and is not withdrawn with them. */}
                      {((canRetry && remedy.offerRetry && !image.nsfwLevelLocked) ||
                        (canOverride && remedy.offerOverride && !image.nsfwLevelLocked) ||
                        (canOverride && image.nsfwLevelLocked)) && (
                        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                          {canRetry && remedy.offerRetry && !image.nsfwLevelLocked && (
                            <ImageRetryButton articleId={articleId} imageId={image.id} />
                          )}
                          {canOverride && remedy.offerOverride && !image.nsfwLevelLocked && (
                            <ImageOverrideControl articleId={articleId} imageId={image.id} />
                          )}
                          {canOverride && image.nsfwLevelLocked && <ImageOverriddenBadge />}
                        </div>
                      )}
                    </div>
                  </Paper>
                );
              })}
            </Stack>
          </Stack>
        )}

        {/* 🔴 This rescans the ARTICLE, which is a different thing from rescanning the image the
          note above says a rescan cannot fix — and after the image is removed, replaced or deleted
          it is the step that actually unblocks the article. `article-ingestion-reconcile` will NOT
          do it for you: that cron selects only `ingestion IN (Pending, Rescan)` or
          `(Processing, Scanned)`, and an article blocked by an unrenderable image sits at `Error`.
          The note names the rescan for that reason; keep the two wordings in step. */}
        {canRescan && (
          <Group justify="flex-end">
            <Button
              leftSection={<IconRadar2 size={16} />}
              variant="default"
              size="sm"
              loading={isRescanning}
              onClick={() => rescan(articleId)}
            >
              Rescan Article
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
