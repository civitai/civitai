import { Alert, AlertProps, Text, Anchor } from '@mantine/core';
import { HiddenType } from '@prisma/client';

export function HiddenContentAlert({ hidden, ...alertProps }: Props) {
  return (
    <Alert
      color="yellow"
      className="rounded-lg p-3"
      classNames={{ message: 'flex flex-col items-center justify-center' }}
      {...alertProps}
    >
      <Text color="yellow" className="font-bold">
        Content hidden
      </Text>
      {hidden === 'MissingMetadata' ? (
        <Text>
          Your cover image has been detected to include graphic content. Per our{' '}
          <Anchor href="/content/tos" target="_blank" rel="nofollow noreferrer">
            ToS
          </Anchor>
          , graphic content on Civitai is required to have artistic, educational or scientific
          value. To have your image appear please ensure it has metadata.
        </Text>
      ) : (
        <Text>
          Your image won&apos;t show up in the feed because it&apos;s marked as graphic content. If
          your image has been marked as graphic content in error, please change the rating and a
          moderator will review your image shortly.
        </Text>
      )}
    </Alert>
  );
}

interface Props extends Omit<AlertProps, 'children' | 'hidden'> {
  hidden: HiddenType;
}
