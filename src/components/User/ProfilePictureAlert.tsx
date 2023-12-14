import { Alert, Anchor } from '@mantine/core';
import { ImageIngestionStatus } from '@prisma/client';

export function ProfilePictureAlert({ ingestion }: Props) {
  if (ingestion === ImageIngestionStatus.Pending)
    return (
      <Alert color="yellow">
        Your profile picture is currently being scanned. You&apos;ll still be able to see it, but
        other users won&apos;t see your profile picture until it has finished the scan process.
      </Alert>
    );

  if (ingestion === ImageIngestionStatus.Blocked)
    return (
      <Alert color="red">
        Your profile picture has been blocked and won&apos;t be visible for other users. This means
        that it was rejected by our automated scanning process. Please provide a different picture
        which comply with our{' '}
        <Anchor href="/content/tos" target="_blank" rel="nofollow" span>
          TOS
        </Anchor>
        .
      </Alert>
    );

  return null;
}

type Props = { ingestion: ImageIngestionStatus | undefined };
