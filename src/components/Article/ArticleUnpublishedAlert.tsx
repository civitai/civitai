import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import {
  getArticleUnpublishReason,
  isArticleUnpublishReason,
} from '~/server/common/moderation-helpers';

export function ArticleUnpublishedAlert({
  reason,
  customMessage,
  showSupportHint,
}: {
  reason?: string | null;
  customMessage?: string | null;
  showSupportHint?: boolean;
}) {
  const detail = reason ? getArticleUnpublishReason(reason) : undefined;
  const isPolicy = detail?.type !== 'quality';
  const color = isPolicy ? 'red' : 'yellow';
  // Only the article list's labels are written for an author. A legacy key falls back to the model
  // copy for its body, but heading the banner "Missing images" would put a model's vocabulary in the
  // most prominent line on the page.
  const label = reason && isArticleUnpublishReason(reason) ? detail?.optionLabel : undefined;

  return (
    <Alert
      variant="light"
      color={color}
      icon={<IconAlertTriangle size={20} />}
      // Mantine tints the title with the alert colour, which lands at 2.9:1 on the light-mode
      // background — under AA at 14px. The icon and the tint carry the severity; the title carries
      // the words, so it keeps the body colour.
      styles={{ title: { color: 'var(--mantine-color-text)' } }}
      title={
        isPolicy
          ? 'This article has been unpublished due to a Terms of Service violation'
          : `This article has been unpublished${label ? `: ${label}` : ''}`
      }
    >
      <Stack gap={6} maw="65ch">
        {detail?.notificationMessage && (
          <Text size="sm" fw={500}>
            {detail.notificationMessage}
          </Text>
        )}
        {customMessage && (
          <Text size="sm">
            <Text span fw={600} inherit>
              Additional details:
            </Text>{' '}
            {customMessage}
          </Text>
        )}
        {showSupportHint && (
          <Text size="sm">If you believe this was done in error, please contact support.</Text>
        )}
      </Stack>
    </Alert>
  );
}
