// Cross-root RECEIVER. A spoke on a different registrable domain (civitai.red) can't see
// the hub's .civitai.com cookie, so it mints its OWN local session from a swap token pulled
// from the hub. This is the next-auth side of the existing `account-switch` flow
// (swapAccount -> signIn('account-switch', token)), but the transport token is now a signed
// JWS verified via JWKS instead of an AES civ-token — so the spoke holds no shared secret.
//
// Inject `verifySwapToken` (from createAuthVerifier) and `resolveUser` (the app's
// getSessionUser). The provider stays free of app/db imports.
import type { User as NextAuthUser } from 'next-auth';
import type { SessionUser } from './types';

export interface AccountSwitchConfig {
  /** From createAuthVerifier().verifySwapToken — validates the hub-minted swap token. */
  verifySwapToken: (token: string) => Promise<{ userId: number } | null>;
  /** App-provided: load the full session user for a verified userId (e.g. getSessionUser). */
  resolveUser: (userId: number) => Promise<SessionUser | null>;
  /** Provider id — defaults to 'account-switch' to match the existing client call. */
  id?: string;
}

/**
 * Build the `account-switch` CredentialsProvider. Drop into the spoke's next-auth
 * `providers: [...]`. The client calls `signIn('account-switch', { token })`.
 *
 * Async + dynamic-imports next-auth so the package's static graph stays next-auth-free
 * (non-next-auth consumers never load this path). Spokes await it when building providers.
 */
export async function createAccountSwitchProvider(config: AccountSwitchConfig) {
  const { default: CredentialsProvider } = await import('next-auth/providers/credentials');
  return CredentialsProvider({
    id: config.id ?? 'account-switch',
    name: 'Account Switch',
    credentials: { token: { label: 'Swap token', type: 'text' } },
    async authorize(credentials): Promise<NextAuthUser | null> {
      const token = credentials?.token;
      if (!token) return null;
      const result = await config.verifySwapToken(token);
      if (!result) return null;
      const user = await config.resolveUser(result.userId);
      if (!user) return null;
      // next-auth expects its (app-augmented) User; the jwt() callback fills in the rest.
      return user as unknown as NextAuthUser;
    },
  });
}
