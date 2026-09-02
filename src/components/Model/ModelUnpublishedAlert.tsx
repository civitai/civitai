import { Text } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import type { UnpublishReason } from '~/server/common/moderation-helpers';
import { unpublishReasons } from '~/server/common/moderation-helpers';

/** Copy says "model" at both call sites, the version panel's version-level take-down included — don't narrow it to "version" there. */
export function ModelUnpublishedAlert({
  reason,
  customMessage,
  showAppeal,
}: {
  reason?: string | null;
  customMessage?: string | null;
  showAppeal?: boolean;
}) {
  const detail = unpublishReasons[(reason ?? 'other') as UnpublishReason];
  const isPolicy = detail?.type !== 'quality';
  const color = isPolicy ? 'red' : 'yellow';
  const message =
    detail?.notificationMessage || `Removal reason: ${customMessage || 'No reason provided.'}`;

  return (
    <AlertWithIcon color={color} iconColor={color} icon={<IconExclamationMark />} size="sm">
      <Text>
        {isPolicy ? (
          <>
            This model has been unpublished due to a violation of our{' '}
            <Text component="a" c="blue.4" href="/content/tos" target="_blank">
              guidelines
            </Text>{' '}
            and is not visible to the community.
          </>
        ) : (
          <>This model has been unpublished and is not visible to the community.</>
        )}{' '}
        {message}
      </Text>
      <Text>
        {isPolicy
          ? 'If you adjust your model to comply with our guidelines, you can request a review from one of our moderators.'
          : 'Once you have addressed this, you can request a review from one of our moderators.'}
        {showAppeal && (
          <>
            {' '}
            If you believe this was done in error, you can{' '}
            <Text component="a" c="blue.4" href="/content/content-appeal" target="_blank">
              submit an appeal
            </Text>
            .
          </>
        )}
      </Text>
    </AlertWithIcon>
  );
}
