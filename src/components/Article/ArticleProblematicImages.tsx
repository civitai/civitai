/**
 * Article Problematic Images Component
 *
 * Displays a detailed list of blocked and error images for article content
 */

import { Alert, Text, Stack, Group, Paper } from '@mantine/core';
import { IconAlertTriangle, IconX, IconExclamationCircle } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

interface ArticleProblematicImagesProps {
  blockedImages: Array<{
    id: number;
    url: string;
    ingestion: ImageIngestionStatus;
    blockedFor: string | null;
  }>;
  errorImages: Array<{ id: number; url: string; ingestion: ImageIngestionStatus }>;
}

export function ArticleProblematicImages({
  blockedImages,
  errorImages,
}: ArticleProblematicImagesProps) {
  const hasProblems = blockedImages.length > 0 || errorImages.length > 0;
  if (!hasProblems) return null;

  return (
    <Alert
      icon={<IconAlertTriangle size={16} />}
      title="Action Required - Problematic Images"
      color="red"
      className="border-l-4 border-red-6"
    >
      <Stack gap="md">
        <Text size="sm">
          The following images must be removed or replaced before your article can be published:
        </Text>

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
                <Paper key={image.id} p="xs" withBorder className="bg-red-1 dark:bg-red-9/20">
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
                      <Text size="xs" c="dimmed">
                        Image ID: {image.id}
                      </Text>
                    </Stack>
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
            <Text size="xs" c="dimmed">
              These images failed to scan or were not found
            </Text>
            <Stack gap="sm">
              {errorImages.map((image) => (
                <Paper key={image.id} p="xs" className="bg-yellow-1 dark:bg-yellow-9/20" withBorder>
                  <Group gap="sm" wrap="nowrap">
                    <div className="relative size-16 shrink-0 overflow-hidden rounded border border-yellow-6 bg-gray-1 dark:bg-gray-8">
                      <EdgeMedia
                        src={image.url}
                        width={64}
                        className="size-full object-cover"
                        alt="Error image (may be broken)"
                      />
                    </div>
                    <Text size="xs" c="dimmed">
                      Image ID: {image.id} • Status: {image.ingestion}
                    </Text>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </Stack>
        )}

        {/* Action Instructions */}
        <Alert color="blue" variant="light" styles={{ root: { padding: '8px 12px' } }}>
          <Text size="xs" fw={500}>
            How to fix:
          </Text>
          <Text size="xs" mt={4}>
            1. Locate these images in your article content
            <br />
            2. Remove or replace them with appropriate images
            <br />
            3. Save your article to trigger a new scan
          </Text>
        </Alert>
      </Stack>
    </Alert>
  );
}
