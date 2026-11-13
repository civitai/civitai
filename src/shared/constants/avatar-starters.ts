import { getEdgeUrl } from '~/client-utils/edge-url';
import manifest from './avatar-starters.json';

type StoredImage = { imageId: number; url: string };
export type AvatarStarter = { character: string; colour: StoredImage; grey: StoredImage };

/** The same four people appear in every style; the first is each style's cover and the default. */
export const avatarStarterCharacters = ['mara', 'dev', 'ines', 'theo'] as const;
export const DEFAULT_AVATAR_CHARACTER = avatarStarterCharacters[0];

const startersByStyle = manifest as Record<string, AvatarStarter[]>;

export function avatarStartersFor(styleKey: string): AvatarStarter[] {
  return startersByStyle[styleKey] ?? [];
}

export function findAvatarStarter(styleKey: string, character: string) {
  return avatarStartersFor(styleKey).find((starter) => starter.character === character);
}

export const isAvatarStarterCharacter = (value: string) =>
  (avatarStarterCharacters as readonly string[]).includes(value);

export const avatarStarterSrc = (starter: AvatarStarter, width = 450) =>
  getEdgeUrl(starter.colour.url, { width, name: `${starter.character}.jpeg` });

/** Every style has every starter character (`avatar-starters.test.ts`). */
export function avatarStyleCharacterSrc(
  styleKey: string,
  character: string = DEFAULT_AVATAR_CHARACTER,
  width = 450
) {
  return avatarStarterSrc(findAvatarStarter(styleKey, character)!, width);
}
