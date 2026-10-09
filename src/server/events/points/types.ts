// The contract of the event points engine: a ledger of plain facts in ClickHouse, live totals in
// sysRedis, and an hourly referee that recomputes the exact score from the ledger alone.
// Design: every action that can earn points goes through `awardEventPoints`, which decides in one
// Lua call whether the action is a first and how much of it fits under the per-creator cap.

import type { CosmeticEntity } from '~/shared/utils/prisma/enums';

export const EVENT_POINT_TYPES = [
  'view',
  'reaction',
  'comment',
  'sticker',
  'remix',
  'modelLike',
] as const;
export type EventPointType = (typeof EVENT_POINT_TYPES)[number];

export type EventPointEntityType = Extract<CosmeticEntity, 'Image' | 'Model' | 'Article'>;

export type EventPointTypeRule = {
  // Points one qualifying action is worth. Seeds the live weights hash; the referee reads that
  // hash, so a change applies to the whole event, past days included.
  weight: number;
  // How often one person can earn this type on one entity: once per UTC day, or once for the event.
  once: 'day' | 'event';
  entities: readonly EventPointEntityType[];
};

export type EventPointsConfig = {
  // Most points one person can give one creator per UTC day, across every type.
  capPerActorPerOwnerPerDay: number;
  types: Partial<Record<EventPointType, EventPointTypeRule>>;
};

// One event cosmetic instance: a UserCosmetic is keyed by (userId, cosmeticId, claimKey), and the
// claim key tells apart copies of the same cosmetic one person owns.
export type EventHat = { ownerId: number; cosmeticId: number; claimKey: string; team: string };

export type EventPointAction = {
  type: EventPointType;
  // A signed-in user. Signed-out activity never earns points.
  actorId: number;
  entityType: EventPointEntityType;
  entityId: number;
  // When the action happened; defaults to now.
  time?: Date;
  // Id of the source row (reaction, comment, placement, review), so a later removal can net it out.
  sourceId?: string;
};

// A removal nets out an earlier action by its sourceId. It writes a ledger row only; live totals
// correct at the next referee run.
export type EventPointRemoval = Required<Pick<EventPointAction, 'sourceId'>> &
  Pick<EventPointAction, 'type' | 'actorId' | 'entityType' | 'entityId' | 'time'>;
