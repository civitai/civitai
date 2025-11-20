import type { Session, SessionUser } from 'next-auth';
import { createContext, useContext } from 'react';
import type { UserMeta } from '~/server/schema/user.schema';

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

type BrowsingSettings = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden: boolean;
  allowAds: boolean;
  autoplayGifs: boolean;
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

export const CivitaiSessionContext = createContext<AuthedUser | UnauthedUser | null>(null);

export const useCivitaiSessionContext = () => {
  const context = useContext(CivitaiSessionContext);
  if (!context) throw new Error('missing CivitaiSessionContext');
  return context;
};
