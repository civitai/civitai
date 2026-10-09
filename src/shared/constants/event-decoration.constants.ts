import { CosmeticEntity } from '~/shared/utils/prisma/enums';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
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
  /** Flagged users may wear it from here; whether a viewer may is the server's call. */
  previewFrom?: Date;
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
    previewFrom: BIRTHDAY_2026_PREVIEW_FROM,
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
  /** [left, top, right, bottom] of the visible pixels. */
  bounds?: [number, number, number, number];
  /** [left, right, y] of the brim, the widest row the hat rests on. Defaults to the bounds' bottom edge. */
  brim?: [number, number, number];
  /** Convex outline of the visible pixels, as [x, y] points in ring order (it is drawn as a polygon). Defaults to the bounds. */
  outline?: [number, number][];
  /** Brim width on a card, in CSS px. */
  size?: number;
  /** Degrees; negative leans left. */
  tilt?: number;
  /** Share of the hat's height (brim to top) worn on the card. */
  depth?: number;
  /** Hover scale. */
  grow?: number;
  /** [x, y] in CSS px from where the hat would sit; positive is right and down, onto the card. */
  offset?: [number, number];
};

export type EventDecorationData = {
  type: string;
  event: string;
  url: string;
  team?: string;
  design?: string;
  fit?: EventDecorationFit;
};

/** The SQL twin of this test is `jsonb_typeof(data->'event') = 'string'`; keep the two in step. */
export function isEventDecorationData(data: unknown): data is EventDecorationData {
  return (
    !!data && typeof data === 'object' && typeof (data as { event?: unknown }).event === 'string'
  );
}

export function getEventDecorationDefinition(event: string) {
  return EVENT_DECORATION_DEFINITIONS.find((x) => x.event === event);
}

/**
 * Whether someone could wear this event's decorations now: its window, preview included. Who
 * actually may is the server's call (src/server/events/event-access.ts).
 */
export function isEventDecorationInWindow(definition: EventDecorationDefinition, now = new Date()) {
  return now >= (definition.previewFrom ?? definition.startsAt) && now < definition.endsAt;
}

/** The event, if any, whose decorations someone could wear on this entity type now. */
export function getEventDecorationInWindow(entityType: CosmeticEntity, now = new Date()) {
  return EVENT_DECORATION_DEFINITIONS.find(
    (x) => isEventDecorationInWindow(x, now) && x.entityTypes.includes(entityType)
  );
}
