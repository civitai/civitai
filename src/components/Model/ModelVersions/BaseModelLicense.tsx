import { Group, Text } from '@mantine/core';
import { IconLicense } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { DisplayedBaseModelLicense, LicenseLine } from '~/server/common/constants';

function LicenseLink({ name, url }: LicenseLine) {
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

function ScopedLine(line: LicenseLine) {
  return (
    <Group gap={4} wrap="wrap" align="center">
      {line.label && (
        <Text size="xs" c="dimmed" fw={600} style={{ lineHeight: 1.1 }}>
          {line.label}
        </Text>
      )}
      <LicenseLink {...line} />
      {line.suffix && (
        <Text size="xs" c="dimmed" style={{ lineHeight: 1.1 }}>
          {line.suffix}
        </Text>
      )}
    </Group>
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
  const lines = license?.lines ?? [];
  // A lone public licence sits beside the label; scoped lines each get a row.
  const inline = lines.length === 1 && !lines[0].label ? lines[0] : undefined;

  return (
    <>
      <Group gap={4} wrap="wrap" align="center">
        <IconLicense size={16} />
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', lineHeight: 1.1 }}>
          License{plural ? 's' : ''}:
        </Text>
        {inline && <LicenseLink {...inline} />}
        {children}
      </Group>
      {!inline && lines.map((line) => <ScopedLine key={line.name} {...line} />)}
    </>
  );
}
