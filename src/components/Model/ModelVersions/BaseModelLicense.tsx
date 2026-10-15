import { Group, Text } from '@mantine/core';
import { IconLicense } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { DisplayedBaseModelLicense } from '~/server/common/constants';

function LicenseLink({ name, url }: DisplayedBaseModelLicense['primary']) {
  if (url == null)
    return (
      <Text size="xs" c="dimmed" style={{ lineHeight: 1.1 }}>
        {name}
      </Text>
    );

  return (
    <Text
      component="a"
      href={url}
      rel="nofollow noreferrer"
      td="underline"
      target="_blank"
      size="xs"
      c="dimmed"
      style={{ lineHeight: 1.1 }}
    >
      {name}
    </Text>
  );
}

export function BaseModelLicense({
  license,
  plural,
  children,
}: {
  license: DisplayedBaseModelLicense | undefined;
  plural: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <Group gap={4} wrap="wrap" align="center">
        <IconLicense size={16} />
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', lineHeight: 1.1 }}>
          License{plural ? 's' : ''}:
        </Text>
        {license && <LicenseLink {...license.primary} />}
        {children}
      </Group>
      {license?.selfHosted && (
        <Group gap={4} wrap="wrap" align="center">
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.1 }}>
            Self-hosted use:
          </Text>
          <LicenseLink {...license.selfHosted} />
        </Group>
      )}
    </>
  );
}
