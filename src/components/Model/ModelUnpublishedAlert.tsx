import { Alert, Anchor, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { getUnpublishReason } from '~/server/common/moderation-helpers';

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
  const reasonKey = reason ?? 'other';
  const detail = getUnpublishReason(reasonKey);
  const isPolicy = detail?.type !== 'quality';
  const color = isPolicy ? 'red' : 'yellow';
  // Only `other` carries the moderator's own words to the owner. For every other reason the note is
  // written assuming it stays internal, so a key with no entry must render nothing rather than leak it.
  const message =
    reasonKey === 'other'
      ? `Removal reason: ${customMessage || 'No reason provided.'}`
      : detail?.notificationMessage;

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
          ? 'This model has been unpublished due to a violation of our guidelines'
          : 'This model has been unpublished'
      }
    >
      <Stack gap={6} maw="65ch">
        {message && (
          <Text size="sm" fw={500}>
            {message}
          </Text>
        )}
        <Text size="sm">
          It is not visible to the community.{' '}
          {isPolicy ? (
            <>
              If you adjust your model to comply with our{' '}
              <Anchor href="/content/tos" target="_blank" inherit>
                guidelines
              </Anchor>
              , you can request a review from one of our moderators.
            </>
          ) : (
            'Once you have addressed this, you can request a review from one of our moderators.'
          )}
          {showAppeal && (
            <>
              {' '}
              If you believe this was done in error, you can{' '}
              <Anchor href="/content/content-appeal" target="_blank" inherit>
                submit an appeal
              </Anchor>
              .
            </>
          )}
        </Text>
      </Stack>
    </Alert>
  );
}
