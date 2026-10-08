import { getEdgeUrl } from '~/client-utils/edge-url';
import manifest from './avatar-starters.json';

type StoredImage = { imageId: number; url: string };
export type AvatarStarter = { character: string; colour: StoredImage; grey: StoredImage };

/** The same four people appear in every style; the first is each style's cover. */
export const avatarStarterCharacters = ['mara', 'dev', 'ines', 'theo'] as const;
const COVER_CHARACTER = avatarStarterCharacters[0];

const startersByStyle = manifest as Record<string, AvatarStarter[]>;
const STARTER = /^starter:([a-z]+)$/;

export function avatarStartersFor(styleKey: string): AvatarStarter[] {
  return startersByStyle[styleKey] ?? [];
}

/** 'cover' is the style's first starter; `undefined` when the style has no stored starters yet. */
export function findAvatarStarter(styleKey: string, reference: string) {
  const character = reference === 'cover' ? COVER_CHARACTER : STARTER.exec(reference)?.[1];
  if (!character) return undefined;
  return avatarStartersFor(styleKey).find((starter) => starter.character === character);
}

export const isAvatarStarterReference = (reference: string) =>
  reference === 'cover' || STARTER.test(reference);

export const avatarStarterSrc = (starter: AvatarStarter, width = 450) =>
  getEdgeUrl(starter.colour.url, { width, name: `${starter.character}.jpeg` });

export function avatarStyleCoverSrc(styleKey: string, width = 450) {
  const cover = findAvatarStarter(styleKey, 'cover');
  return cover ? avatarStarterSrc(cover, width) : undefined;
}

export function avatarStyleCharacterSrc(styleKey: string, character: string, width = 450) {
  const starter = avatarStartersFor(styleKey).find((s) => s.character === character);
  return starter ? avatarStarterSrc(starter, width) : avatarStyleCoverSrc(styleKey, width);
}
