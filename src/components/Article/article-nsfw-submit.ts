/**
 * The form holds the level as a select string; an unset select sends `undefined` so the server
 * schema applies its default (PG). There is no level 0, and sending one fails the whole save.
 */
export function getUserNsfwLevelSubmit(value: string | undefined, canEdit: boolean) {
  if (!canEdit) return undefined;
  return value ? Number(value) : undefined;
}
