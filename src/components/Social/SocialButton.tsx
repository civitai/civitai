import { BuiltInProviderType } from 'next-auth/providers';
import { ButtonProps } from '@mantine/core';
import { socialItems } from './Social';

type Props = {
  provider: BuiltInProviderType | 'ethereum';
  additionalText?: string;
} & React.ComponentPropsWithoutRef<'button'> &
  ButtonProps;

export function SocialButton({ provider, additionalText, ...buttonProps }: Props) {
  const { Icon, label, Button } = socialItems[provider] ?? {};
  const labelStr = typeof additionalText === 'string' ? `${label} ${additionalText}` : label;

  if (!Button) return null;

  return (
    <Button leftIcon={Icon && <Icon size={20} />} {...buttonProps}>
      {labelStr}
    </Button>
  );
}
