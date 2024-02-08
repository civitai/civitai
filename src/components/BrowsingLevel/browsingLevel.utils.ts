import { NsfwLevel } from '~/server/common/enums';
import { create } from 'zustand';
import { setCookie } from '~/utils/cookies-helpers';
import { useCookies } from '~/providers/CookiesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
import { Flags } from '~/utils/flags';
import { deleteCookie } from 'cookies-next';

export function parseBitwiseBrowsingLevel(level: number): NsfwLevel[] {
  return Flags.instanceToArray(level);
}

export function flagifyBrowsingLevel(levels: NsfwLevel[]) {
  return Flags.arrayToInstance(levels);
}

const useStore = create<number | undefined>(() => undefined);
useStore.subscribe((levels) => {
  if (!levels) deleteCookie('level');
  else setCookie('level', levels);
});

export const setBrowsingLevels = (levels: NsfwLevel[]) =>
  useStore.setState(flagifyBrowsingLevel(levels));

export const toggleBrowsingLevel = (level: NsfwLevel) =>
  useStore.setState((instance) => {
    if (!instance) return level;
    return Flags.hasFlag(instance, level)
      ? Flags.removeFlag(instance, level)
      : Flags.addFlag(instance, level);
  });
export const useBrowsingLevel = () => {
  const currentUser = useCurrentUser();
  const { browsingLevel: cookieLevel } = useCookies();
  const storedLevel = useStore();
  if (!currentUser || currentUser.browsingLevel === 0) return NsfwLevel.PG;
  return storedLevel ?? cookieLevel ?? currentUser.browsingLevel ?? NsfwLevel.PG;
};

export const useBrowsingLevelTags = (level: NsfwLevel) => {
  const { data } = useQueryHiddenPreferences();
  return !data ? [] : data.tag.filter((x) => x.nsfwLevel !== undefined && x.nsfwLevel === level);
};

export type BrowsingLevels = typeof browsingLevels;
export type BrowsingLevel = BrowsingLevels[number];
export const browsingLevels = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
] as const;

export const browsingLevelLabels = {
  [NsfwLevel.PG]: 'PG',
  [NsfwLevel.PG13]: 'PG-13',
  [NsfwLevel.R]: 'R',
  [NsfwLevel.X]: 'X',
  [NsfwLevel.XXX]: 'XXX',
} as const;

export const sfwBrowsingLevels = [NsfwLevel.PG, NsfwLevel.PG13];

export function getIsSfw(level: number) {
  const levels = parseBitwiseBrowsingLevel(level);
  return levels.every((level) => sfwBrowsingLevels.includes(level));
}
