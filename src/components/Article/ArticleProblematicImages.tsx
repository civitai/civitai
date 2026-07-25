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

function ImageOverrideControl({
  articleId,
  imageId,
  locked,
}: {
  articleId: number;
  imageId: number;
  locked: boolean;
}) {
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

  if (locked)
    return (
      <Badge color="green" variant="light" leftSection={<IconShieldCheck size={12} />}>
        Overridden
      </Badge>
    );

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
      ? 'The following content issues must be resolved before your article can be published:'
      : hasTextProblem
      ? 'A text moderation issue is preventing your article from being published:'
      : 'The following images must be removed or replaced before your article can be published:';

  const guidance =
    hasImageProblems && hasTextProblem
      ? 'Remove or replace the flagged images and edit the flagged text, then rescan or save to re-check.'
      : hasTextProblem
      ? 'Edit the flagged title or body, then rescan or save to re-check.'
      : 'Remove or replace the flagged images, then rescan or save to re-check.';

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
              {blockedImages.map((image) => (
                <Paper key={image.id} p="xs" withBorder className="border-l-2 border-l-red-6">
                  <Group gap="sm" wrap="nowrap">
                    <div className="relative size-16 shrink-0 overflow-hidden rounded border border-red-6">
                      <EdgeMedia
                        src={image.url}
                        width={64}
                        className="size-full object-cover"
                        alt="Blocked image (removed for policy violation)"
                      />
                    </div>
                    <Stack gap={4} className="flex-1">
                      <Text size="xs" fw={500} c="red.7">
                        Blocked: {image.blockedFor || 'Policy violation'}
                      </Text>
                      {canOverride && (
                        <Text size="xs" c="dimmed">
                          ID: {image.id}
                        </Text>
                      )}
                    </Stack>
                    {canOverride && (
                      <ImageOverrideControl
                        articleId={articleId}
                        imageId={image.id}
                        locked={image.nsfwLevelLocked}
                      />
                    )}
                  </Group>
                </Paper>
              ))}
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
              {errorImages.map((image) => (
                <Paper key={image.id} p="xs" withBorder className="border-l-2 border-l-yellow-6">
                  <Group gap="sm" wrap="nowrap">
                    <div className="relative size-16 shrink-0 overflow-hidden rounded border border-yellow-6 bg-gray-1 dark:bg-gray-8">
                      <EdgeMedia
                        src={image.url}
                        width={64}
                        className="size-full object-cover"
                        alt="Error image (may be broken)"
                      />
                    </div>
                    <Stack gap={4} className="flex-1">
                      <Text size="xs" fw={500} c="yellow.7">
                        {errorImageCause(image)}
                      </Text>
                      {canOverride && (
                        <Text size="xs" c="dimmed">
                          ID: {image.id}
                        </Text>
                      )}
                    </Stack>
                    {(canRetry || canOverride) && (
                      <Group gap="xs" wrap="nowrap">
                        {canRetry && !image.nsfwLevelLocked && (
                          <ImageRetryButton articleId={articleId} imageId={image.id} />
                        )}
                        {canOverride && (
                          <ImageOverrideControl
                            articleId={articleId}
                            imageId={image.id}
                            locked={image.nsfwLevelLocked}
                          />
                        )}
                      </Group>
                    )}
                  </Group>
                </Paper>
              ))}
            </Stack>
          </Stack>
        )}

        {/* Footer: guidance + rescan CTA */}
        <Group justify="space-between" wrap="wrap" gap="sm" align="center">
          <Text size="xs" c="dimmed" className="flex-1">
            {guidance}
          </Text>
          {canRescan && (
            <Button
              leftSection={<IconRadar2 size={16} />}
              variant="default"
              size="sm"
              loading={isRescanning}
              onClick={() => rescan(articleId)}
            >
              Rescan Article
            </Button>
          )}
        </Group>
      </Stack>
    </Alert>
  );
}
