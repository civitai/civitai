import type { ColumnType } from 'kysely';

// Schema for the MODERATOR database — moderation data that never existed in Civitai's Postgres.
//
// Hand-written, unlike `@civitai/db-schema/kysely`, because these tables are not in the Prisma schema.
// Today the connection points at Retool's own database (`retool_db` in the app exports), so these types
// mirror its live schema exactly, quirks included. When the tables move to a dedicated moderator
// database the definitions here are what the migration targets — see
// docs/moderator-app/retool-exports/retool-db-tables.md.
//
// Two quirks are preserved deliberately rather than corrected, so the types do not lie about what is in
// the database right now:
//   - moderators are recorded by NAME (`createdBy`, `lastUpdateBy`, `handledBy`), not by user id
//   - `TimedMutes.userId` is text while the other tables use integer

// Same definitions prisma-kysely generates for the main schema. `Generated` must unwrap an existing
// ColumnType rather than nest one, or a `Generated<Timestamp>` column selects as ColumnType, not Date.
type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;

/** Free-text moderator notes per user, plus two flags that act as moderation state. */
export type UserNotes = {
  id: Generated<number>;
  userId: number | null;
  notes: string | null;
  lastUpdate: Timestamp | null;
  /** Moderator NAME, not an id. */
  lastUpdateBy: string | null;
  spamWhitelist: boolean | null;
  deservedMute: boolean | null;
};

/** The strike system. No equivalent exists in Civitai's schema. */
export type UserStrikes = {
  id: Generated<number>;
  userId: number | null;
  createdAt: Generated<Timestamp>;
  /** Moderator NAME, not an id. */
  createdBy: string | null;
  reason: string | null;
};

/** Scheduled mutes with an expiry. Empty as of 2026-08-06 — confirm it is still in use. */
export type TimedMutes = {
  id: Generated<number>;
  /** TEXT here, integer in UserNotes/UserStrikes. Cast on migration. */
  userId: string | null;
  muteStart: Timestamp | null;
  muteEnd: Timestamp | null;
  createdBy: string | null;
  createdAt: Generated<Timestamp>;
  muteReason: string | null;
  isMuted: boolean | null;
};

/** Queue for asking another moderator to second-opinion a set of images. */
export type ModerationImageHelp = {
  id: Generated<number>;
  createdBy: string | null;
  /** jsonb array of image ids. */
  imageIds: unknown;
  type: string | null;
  createdAt: Generated<Timestamp>;
  isHandled: boolean | null;
  handledBy: string | null;
  handledAt: Timestamp | null;
};

/**
 * Retool's own action log. Free text with no foreign keys — the user id is embedded in `ActionType`
 * and queried with LIKE. Read-only archive; new activity belongs in ModActivity.
 */
export type ReToolActions = {
  id: Generated<number>;
  Event: Generated<Timestamp>;
  User: string | null;
  App: string | null;
  ActionType: string | null;
};

export type ModeratorDB = {
  UserNotes: UserNotes;
  UserStrikes: UserStrikes;
  TimedMutes: TimedMutes;
  ModerationImageHelp: ModerationImageHelp;
  ReToolActions: ReToolActions;
};
