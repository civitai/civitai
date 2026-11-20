import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { canOpenAppRunPages } from '~/shared/utils/app-blocks-access';
import type { SessionUser } from '~/types/session';

/** The two reads behind {@link canUserOpenAppRunPages}; the defaults import their modules lazily. */
export type RunPageAccessReaders = {
  /** The full SessionUser, or null for a user that no longer resolves. */
  getSessionUser: (userId: number) => Promise<SessionUser | null>;
  /** The user's feature flags, evaluated as a request from them would be (no host, no region). */
  getFeatureFlags: (user: SessionUser) => Promise<Partial<FeatureAccess>>;
};

const defaultReaders: RunPageAccessReaders = {
  getSessionUser: async (userId) => {
    const { sessionClient } = await import('~/server/auth/session-client');
    return (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  },
  getFeatureFlags: async (user) => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    return getFeatureFlagsAsync({ user });
  },
};

/**
 * Whether `userId` can open `/apps/run/<slug>` right now, asked at SEND time by the approved-app
 * notification so it links there only for a submitter the run page would serve.
 *
 * The run page's gate is `canOpenAppRunPages(features)` over the viewer's feature flags. Neither
 * of its flags (`appBlocks`, `appBlocksPages`) has a host or region restriction, and their Flipt
 * context is built from the user alone, so evaluating them for the hydrated user with no request
 * gives the answer the page would give that user. The default reader runs the page's own
 * evaluator (`getFeatureFlagsAsync`), so Flipt being down falls back to the same static rule.
 *
 * Fails toward the submissions view: a user that does not resolve, or any error, answers `false`.
 */
export async function canUserOpenAppRunPages(
  userId: number,
  readers: RunPageAccessReaders = defaultReaders
): Promise<boolean> {
  try {
    const user = await readers.getSessionUser(userId);
    if (!user) return false;
    return canOpenAppRunPages(await readers.getFeatureFlags(user));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[canUserOpenAppRunPages] could not read the run-page flags; linking the submissions view: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}
