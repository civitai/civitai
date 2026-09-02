import { Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
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
    <AlertWithIcon size="lg" icon={<IconAlertCircle />} color={color} iconColor={color}>
      <div>
        <Text weight={600} size="lg" mb="xs">
          {isPolicy
            ? 'This article has been unpublished due to a Terms of Service violation'
            : `This article has been unpublished${label ? `: ${label}` : ''}`}
        </Text>
        {detail?.notificationMessage && (
          <Text>
            <strong>Reason:</strong> {detail.notificationMessage}
          </Text>
        )}
        {customMessage && (
          <Text>
            <strong>Additional details:</strong> {customMessage}
          </Text>
        )}
        {showSupportHint && (
          <Text mt="sm" size="sm">
            If you believe this was done in error, please contact support.
          </Text>
        )}
      </div>
    </AlertWithIcon>
  );
}
