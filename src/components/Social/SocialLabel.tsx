import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import type { BuiltInProviderType } from 'next-auth/providers/index';
import { socialItems } from './Social';

type Props = {
  type: BuiltInProviderType;
} & GroupProps;

export function SocialLabel({ type }: Props) {
  const { Icon, label } = socialItems[type] ?? {};

  return (
    <Group gap="xs">
      {Icon && <Icon size={16} />}
      {label}
    </Group>
  );
}
