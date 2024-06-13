import { Alert, AlertProps, Text } from '@mantine/core';
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
        Restricted Viewing
      </Text>
      {hidden === 'MissingMetadata' ? (
        <Text>
          This content won&apos;t show up in the feeds because it&apos;s marked as graphic content
          and it&apos;s missing metadata, which is required based on our TOS.
        </Text>
      ) : (
        <Text>
          This content won&apos;t show up in the feed because it&apos;s marked as graphic content.
        </Text>
      )}
    </Alert>
  );
}

interface Props extends Omit<AlertProps, 'children' | 'hidden'> {
  hidden: HiddenType;
}
