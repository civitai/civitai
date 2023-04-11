import { OAuthProviderType } from 'next-auth/providers';
import { BuiltInProviderType } from 'next-auth/providers';
import { ClientSafeProvider, LiteralUnion } from 'next-auth/react';

type NextAuthProviders = Record<
  LiteralUnion<BuiltInProviderType | 'ethereum', string>,
  ClientSafeProvider
> | null;

/**
 * Filter from the providers object
 * @param providers - Object containing all providers
 * @returns Filtered object
 */
export const filterProviders = (providers: NextAuthProviders): NextAuthProviders => {
  if (!providers) {
    return providers;
  }

  const filteredProviders: any = {};

  Object.entries(providers).forEach(([key, value]) => {
    if (
      !(['discord', 'google', 'reddit'] as OAuthProviderType[]).includes(key as OAuthProviderType)
    ) {
      filteredProviders[key] = value;
    }
  });

  return filteredProviders;
};
