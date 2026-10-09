import { CosmeticEntity } from '~/shared/utils/prisma/enums';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

/**
 * An event decoration is a `ContentDecoration` cosmetic whose `data.event` names an event below.
 * It is worn BESIDE a frame, not instead of one: an entity holds at most one frame and at most
 * one event decoration. `data.type` picks how it is drawn (`'hat'` sits on the card's corner).
 *
 * A new event's decoration is new art plus an entry here; nothing else should need to change.
 */
export type EventDecorationDefinition = {
  event: string;
  /** What the decoration is called in menus, e.g. "Party Hat". */
  label: string;
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
  /** What it can be worn on. */
  entityTypes: readonly CosmeticEntity[];
  /** How soon one decoration may be placed again after it was last placed. */
  moveCooldownMs: number;
};

export const EVENT_DECORATION_DEFINITIONS: readonly EventDecorationDefinition[] = [
  {
    event: BIRTHDAY_2026_EVENT,
    label: 'Party Hat',
    startsAt: BIRTHDAY_2026_STARTS_AT,
    endsAt: BIRTHDAY_2026_ENDS_AT,
    entityTypes: [CosmeticEntity.Image, CosmeticEntity.Model, CosmeticEntity.Article],
    moveCooldownMs: 10 * 60 * 1000,
  },
];

/**
 * How one piece of art sits on a card, for art that differs from the default convention
 * (128x160 canvas, drawn upright, visible pixels down to y=156). Coordinates are canvas px.
 */
export type EventDecorationFit = {
  /** [width, height] of the image file. */
  canvas?: [number, number];
  /** [left, top, right, bottom] of the visible pixels. The hat rests on the bottom-centre. */
  bounds?: [number, number, number, number];
  /** Longer side of the visible pixels on a card, in CSS px. */
  size?: number;
  /** Degrees; negative leans left. Ignored where the placement stands the hat upright. */
  tilt?: number;
};

export type EventDecorationData = {
  type: string;
  event: string;
  url: string;
  team?: string;
  design?: string;
  fit?: EventDecorationFit;
};

/** The SQL twin of this test is `(data->>'event') IS NOT NULL`; keep the two in step. */
export function isEventDecorationData(data: unknown): data is EventDecorationData {
  return (
    !!data && typeof data === 'object' && typeof (data as { event?: unknown }).event === 'string'
  );
}

export function getEventDecorationDefinition(event: string) {
  return EVENT_DECORATION_DEFINITIONS.find((x) => x.event === event);
}

export function isEventDecorationLive(definition: EventDecorationDefinition, now = new Date()) {
  return now >= definition.startsAt && now < definition.endsAt;
}

/** The live event, if any, whose decorations can be worn on this entity type. */
export function getLiveEventDecorationDefinition(entityType: CosmeticEntity, now = new Date()) {
  return EVENT_DECORATION_DEFINITIONS.find(
    (x) => isEventDecorationLive(x, now) && x.entityTypes.includes(entityType)
  );
}

/** Entity types that any live event lets a decoration be worn on. Empty between events. */
export function getLiveEventDecorationEntityTypes(now = new Date()) {
  return new Set(
    EVENT_DECORATION_DEFINITIONS.filter((x) => isEventDecorationLive(x, now)).flatMap(
      (x) => x.entityTypes
    )
  );
}
