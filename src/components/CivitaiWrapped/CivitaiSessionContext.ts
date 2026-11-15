import { createContext, useContext } from 'react';
import type { Session, SessionUser } from '~/types/session';
import type { UserMeta } from '~/server/schema/user.schema';
import type { EventPointPops } from '~/shared/constants/event-point-pops.constants';

// The session context and its hooks, apart from `CivitaiSessionProvider`, so a reader of the
// session (useCurrentUser, BrowserSettingsProvider) does not load the provider's own imports.
// The provider re-exports everything here, so imports from its path keep working.

export type CivitaiSessionUser = SessionUser & {
  isMember: boolean;
  refresh: () => Promise<Session | null>;
  showNsfw: boolean;
  blurNsfw: boolean;
  disableHidden?: boolean;
  browsingLevel: number;
  meta?: UserMeta;
  isPaidMember: boolean;
  emailHash?: string;
};

type SharedUser = { settings: BrowsingSettings };
export type AuthedUser = { type: 'authed' } & SharedUser & CivitaiSessionUser;
export type UnauthedUser = { type: 'unauthed' } & SharedUser;

export type CurrentUser = Omit<
  AuthedUser,
  | 'type'
  | 'allowAds'
  | 'showNsfw'
  | 'blurNsfw'
  | 'browsingLevel'
  | 'disableHidden'
  | 'autoplayGifs'
  | 'settings'
>;

export type BrowsingSettings = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden: boolean;
  allowAds: boolean;
  autoplayGifs: boolean;
  showEventCosmetics: boolean;
  eventPointPops: EventPointPops;
};

export const CivitaiSessionContext = createContext<AuthedUser | UnauthedUser | null>(null);

export const useCivitaiSessionContext = () => {
  const context = useContext(CivitaiSessionContext);
  if (!context) throw new Error('missing CivitaiSessionContext');
  return context;
};

/** The session, or `null` outside the provider, for shared UI that renders without one. */
export const useOptionalCivitaiSessionContext = () => useContext(CivitaiSessionContext);
