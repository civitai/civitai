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

  const filteredProviders: unknown = Object.fromEntries(
    Object.entries(providers).filter(
      ([key]) =>
        !(['discord', 'google', 'reddit'] as OAuthProviderType[]).includes(key as OAuthProviderType)
    )
  );

  return filteredProviders as NextAuthProviders;
};
