import type { ButtonProps } from '@mantine/core';
import type { BuiltInProviderType } from 'next-auth/providers/index';
import { env } from '~/env/client';
import { socialItems } from './Social';

type Props = {
  provider: BuiltInProviderType;
} & React.ComponentPropsWithoutRef<'button'> &
  ButtonProps;

export function SocialButton({ provider, ...buttonProps }: Props) {
  const { Icon, label, Button } = socialItems[provider] ?? {};

  if (!Button) return null;

  return (
    <Button leftSection={Icon && <Icon size={20} />} {...buttonProps}>
      {label}
    </Button>
  );
}

export const providers = [
  {
    id: 'discord',
    name: 'Discord',
    type: 'oauth',
    signinUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/signin/discord`,
    callbackUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/callback/discord`,
  },
  {
    id: 'github',
    name: 'GitHub',
    type: 'oauth',
    signinUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/signin/github`,
    callbackUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/callback/github`,
  },
  {
    id: 'google',
    name: 'Google',
    type: 'oauth',
    signinUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/signin/google`,
    callbackUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/callback/google`,
  },
  {
    id: 'reddit',
    name: 'Reddit',
    type: 'oauth',
    signinUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/signin/reddit`,
    callbackUrl: `${env.NEXT_PUBLIC_BASE_URL}/api/auth/callback/reddit`,
  },
];
