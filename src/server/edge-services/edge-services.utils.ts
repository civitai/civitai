import { SessionUser } from 'next-auth';
import { BrowsingMode } from '~/server/common/enums';
import { env } from '~/env/server.mjs';
import { camelToSnakeCase } from '~/utils/string-helpers';

export const getEdgeKeys = (key: string, query: Record<string, unknown>) => {
  return Object.entries(query).reduce<string[]>((acc, [key, value]) => {
    if (Array.isArray(value)) {
    } else return [...acc, `${camelToSnakeCase(key)}_${value}`];
  }, []);
};

export const getShowNsfw = (browsingMode: BrowsingMode, currentUser?: SessionUser) => {
  const canViewNsfw = currentUser?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const hideNSFWModels = browsingMode === BrowsingMode.SFW || !canViewNsfw;
  return !hideNSFWModels;
};
