/**
 * Article Image Scan Status Component
 *
 * Displays real-time scanning progress for article content images with modern UI
 */

import { Alert, Text, Group, Stack, Badge, Loader, Paper } from '@mantine/core';
import { IconAlertCircle, IconCheck, IconShield } from '@tabler/icons-react';
import { useArticleScanStatus } from '~/hooks/useArticleScanStatus';
import { useEffect } from 'react';
import clsx from 'clsx';
import { ArticleProblematicImages } from './ArticleProblematicImages';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

interface ArticleScanStatusProps {
  articleId: number;
  onComplete?: () => void;
}

export function ArticleScanStatus({ articleId, onComplete }: ArticleScanStatusProps) {
  const features = useFeatureFlags();
  const { status, isLoading, error, isComplete, hasImages, progress } = useArticleScanStatus({
    articleId,
  });

  // Call onComplete callback when scanning finishes
  useEffect(() => {
    if (isComplete && onComplete) {
      onComplete();
    }
  }, [isComplete]);

  if (!features.articleImageScanning) return null;

  // Error state
  if (error) {
    return (
      <Alert icon={<IconAlertCircle size={16} />} title="Scan Status Error" color="red">
        Failed to load scan status. Please refresh the page.
      </Alert>
    );
  }

  // Loading initial data
  if (isLoading || !status) {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading scan status...
        </Text>
      </Group>
    );
  }

  // No images to scan
  if (!hasImages) {
    return null;
  }

  // All processing complete - check for issues
  if (isComplete) {
    const hasBlockedImages = status.blocked > 0;
    const hasErrorImages = status.error > 0;
    const hasIssues = hasBlockedImages || hasErrorImages;

    // Action required state - blocked or error images
    if (hasIssues) {
      return (
        <Stack gap="md">
          <ArticleProblematicImages
            blockedImages={status.images?.blocked || []}
            errorImages={status.images?.error || []}
          />
        </Stack>
      );
    }

    // Success state - all images scanned successfully
    return (
      <Alert
        icon={<IconCheck size={16} />}
        title="Scan Complete"
        color="green"
        className="border-l-4 border-green-6 transition-all duration-300"
      >
        <Text size="sm">All {status.total} images have been scanned successfully.</Text>
      </Alert>
    );
  }

  // Dynamic segments based on total images (max 50 for performance, min 10 for visibility)
  const segments = Math.min(status.total, 50);
  const scannedSegments = Math.round((status.scanned / status.total) * segments);
  const blockedSegments = Math.round((status.blocked / status.total) * segments);
  const errorSegments = Math.round((status.error / status.total) * segments);

  // Calculate segment boundaries for type determination
  const scannedEnd = scannedSegments;
  const blockedEnd = scannedSegments + blockedSegments;
  const errorEnd = scannedSegments + blockedSegments + errorSegments;

  // Helper function to determine segment type based on index
  const getSegmentType = (index: number): 'scanned' | 'blocked' | 'error' | 'pending' => {
    if (index < scannedEnd) return 'scanned';
    if (index < blockedEnd) return 'blocked';
    if (index < errorEnd) return 'error';
    return 'pending';
  };

  // Scanning in progress - enhanced UI
  return (
    <Paper
      p="md"
      radius="md"
      className="border-l-4 border-blue-6 bg-blue-1/30 transition-all duration-300 dark:bg-blue-9/30"
      withBorder
    >
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <IconShield size={20} className="text-blue-6 dark:text-blue-4" />
            <Text fw={600} size="sm">
              Scanning Images
            </Text>
          </Group>
          <Badge color="blue" variant="light" leftSection={<Loader size={12} />}>
            {Math.round(progress)}% Complete
          </Badge>
        </Group>

        {/* Description */}
        <Text size="sm" c="dimmed">
          Processing {status.total} content images for safety and NSFW classification...
        </Text>

        {/* Segmented Progress Bar */}
        <div className="flex w-full gap-1">
          {Array.from({ length: segments }).map((_, index) => {
            const segmentType = getSegmentType(index);
            return (
              <div
                key={index}
                className={clsx('h-2 flex-1 rounded-sm transition-all duration-300', {
                  ['bg-green-5 dark:bg-green-6']: segmentType === 'scanned',
                  ['bg-red-5 dark:bg-red-6']: segmentType === 'blocked',
                  ['bg-yellow-5 dark:bg-yellow-6']: segmentType === 'error',
                  ['bg-gray-3 dark:bg-gray-6']: segmentType === 'pending',
                })}
                style={{
                  transitionDelay: `${index * 10}ms`,
                }}
              />
            );
          })}
        </div>

        {/* Status Breakdown */}
        <Group gap="md" wrap="wrap">
          <Group gap={4}>
            <div className="size-2 rounded-full bg-green-5 dark:bg-green-6" />
            <Text size="xs" c="dimmed">
              Scanned:{' '}
              <Text component="span" fw={500} inherit>
                {status.scanned}
              </Text>
            </Text>
          </Group>

          {status.blocked > 0 && (
            <Group gap={4}>
              <div className="size-2 rounded-full bg-red-5 dark:bg-red-6" />
              <Text size="xs" c="dimmed">
                Blocked:{' '}
                <Text component="span" fw={500} inherit>
                  {status.blocked}
                </Text>
              </Text>
            </Group>
          )}

          {status.error > 0 && (
            <Group gap={4}>
              <div className="size-2 rounded-full bg-yellow-5 dark:bg-yellow-6" />
              <Text size="xs" c="dimmed">
                Errors:{' '}
                <Text component="span" fw={500} inherit>
                  {status.error}
                </Text>
              </Text>
            </Group>
          )}

          <Group gap={4}>
            <div className="size-2 rounded-full bg-gray-4 dark:bg-gray-6" />
            <Text size="xs" c="dimmed">
              Pending:{' '}
              <Text component="span" fw={500} inherit>
                {status.pending}
              </Text>
            </Text>
          </Group>

          <Text size="xs" c="dimmed" ml="auto">
            Total:{' '}
            <Text component="span" fw={500} inherit>
              {status.total}
            </Text>
          </Text>
        </Group>

        {/* Warning message for issues */}
        {(status.blocked > 0 || status.error > 0) && (
          <Alert
            icon={<IconAlertCircle size={14} />}
            color="yellow"
            variant="light"
            styles={{
              root: { padding: '8px 12px' },
              message: { fontSize: '12px' },
            }}
          >
            Images with errors or violations will not appear in your article.
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}
