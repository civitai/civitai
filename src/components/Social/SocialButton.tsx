import { BuiltInProviderType } from 'next-auth/providers';
import { ButtonProps } from '@mantine/core';
import { socialItems } from './Social';

type Props = {
  provider: BuiltInProviderType;
} & React.ComponentPropsWithoutRef<'button'> &
  ButtonProps;

export function SocialButton({ provider, ...buttonProps }: Props) {
  const { Icon, label, Button } = socialItems[provider] ?? {};

  if (!Button) return null;

  return (
    <Button leftIcon={Icon && <Icon size={20} />} {...buttonProps}>
      {label}
    </Button>
  );
}
