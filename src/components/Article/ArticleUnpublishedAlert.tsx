import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { getArticleUnpublishReason } from '~/server/common/moderation-helpers';

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
  // An unknown reason resolves no detail, and `!== 'quality'` would then head the banner as a ToS violation.
  const isPolicy = detail?.type === 'policy';
  const color = isPolicy ? 'red' : 'yellow';
  const isOther = reason === 'other';

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
          : `This article has been unpublished${detail ? `: ${detail.optionLabel}` : ''}`
      }
    >
      <Stack gap={6} maw="65ch">
        {!detail && (
          <Text size="sm" fw={500}>
            A moderator unpublished this article.
          </Text>
        )}
        {detail && !isOther && (
          <Text size="sm" fw={500}>
            {detail.notificationMessage}
          </Text>
        )}
        {/* `other` has no canned copy, so the moderator's note is the only reason the author gets. */}
        {isOther && (
          <Text size="sm">
            <Text span fw={600} inherit>
              Removal reason:
            </Text>{' '}
            {customMessage || 'No reason provided.'}
          </Text>
        )}
        {showSupportHint && (
          <Text size="sm">If you believe this was done in error, please contact support.</Text>
        )}
      </Stack>
    </Alert>
  );
}
