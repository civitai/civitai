import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';

export type UserCosmetics = RouterOutput['user']['getCosmetics'];

/**
 * The profile slots an Inventory page equips, each a `user.update` field. Sent alone, the others stay
 * as they are: `updateUserHandler` only touches a slot whose id is defined.
 */
export const EQUIPPABLE_KINDS = {
  badges: { group: 'badges', slot: 'badgeId', noun: 'badge' },
  'avatar-decorations': {
    group: 'profileDecorations',
    slot: 'profileDecorationId',
    noun: 'avatar decoration',
  },
  nameplates: { group: 'nameplates', slot: 'nameplateId', noun: 'nameplate' },
  backgrounds: {
    group: 'profileBackground',
    slot: 'profileBackgroundId',
    noun: 'profile background',
  },
  'card-glows': { group: 'cardDecorations', slot: 'cardDecorationId', noun: 'card glow' },
} as const satisfies Record<
  string,
  { group: keyof UserCosmetics; slot: `${string}Id`; noun: string }
>;

export type EquippableKind = keyof typeof EQUIPPABLE_KINDS;

/** One entry per cosmetic: equipping goes by cosmetic id, so a second copy adds nothing to pick. */
export function uniqueCosmetics<T extends { id: number }>(items: T[]) {
  const seen = new Set<number>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
}

type EquippableItem = UserCosmetics[(typeof EQUIPPABLE_KINDS)[EquippableKind]['group']][number];

export function equippableOf(data: UserCosmetics | undefined, kind: EquippableKind) {
  const items: EquippableItem[] = data?.[EQUIPPABLE_KINDS[kind].group] ?? [];
  // Equipping stamps every copy held then; one got later is not, and may be the copy listed.
  const worn = new Set(items.filter((item) => item.equipped).map((item) => item.id));
  return uniqueCosmetics(items).map((item) => ({ ...item, equipped: worn.has(item.id) }));
}

/** Hats are event decorations; every other content decoration is a frame. */
export function hatsOf(data: UserCosmetics | undefined) {
  return (data?.contentDecorations ?? []).filter((c) => isEventDecorationData(c.data));
}

export function framesOf(data: UserCosmetics | undefined) {
  return (data?.contentDecorations ?? []).filter((c) => !isEventDecorationData(c.data));
}

export function stickersOf(data: UserCosmetics | undefined) {
  return uniqueCosmetics(data?.sticker ?? []);
}

const ENTITY_PATHS: Record<CosmeticEntity, string> = {
  Model: 'models',
  Image: 'images',
  Article: 'articles',
  Post: 'posts',
  Model3D: '3d-models',
};

/** Where a frame is applied, or null when it is not on anything. */
export function frameTargetHref(equippedToType: string | null, equippedToId: number | null) {
  const path = equippedToType ? ENTITY_PATHS[equippedToType as CosmeticEntity] : undefined;
  return path && equippedToId ? `/${path}/${equippedToId}` : null;
}

export const useInventoryCosmetics = useQueryUserCosmetics;

/** Nav counts from the same `user.getCosmetics` read the pages make. */
export function useInventoryCosmeticCount(count: (data: UserCosmetics) => number) {
  const { data } = useInventoryCosmetics();
  return data ? count(data) : undefined;
}
