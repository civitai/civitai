import { GroupProps, Group } from '@mantine/core';
import { BuiltInProviderType } from 'next-auth/providers';
import { socialItems } from './Social';

type Props = {
  type: BuiltInProviderType;
} & GroupProps;

export function SocialLabel({ type }: Props) {
  const { Icon, label } = socialItems[type] ?? {};

  return (
    <Group spacing="xs">
      {Icon && <Icon size={16} />}
      {label}
    </Group>
  );
}
