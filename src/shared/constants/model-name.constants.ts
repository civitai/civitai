// Names saved before the cap may be longer. The cap applies only when a name is created or changed,
// so an untouched long name keeps saving.
export const MODEL_NAME_MAX_LENGTH = 100;

export const MODEL_NAME_TOO_LONG_MESSAGE = `Model name must be ${MODEL_NAME_MAX_LENGTH} characters or fewer.`;

/** `storedName` is the name being replaced, or undefined for a new model. */
export function isModelNameTooLong(name: string, storedName?: string | null) {
  if (name.length <= MODEL_NAME_MAX_LENGTH) return false;
  // The upsert schema trims input and older rows were not trimmed, so an untouched name can differ
  // from the stored one by surrounding whitespace alone.
  return storedName == null || name.trim() !== storedName.trim();
}

/** For names the server builds itself, where refusing would fail a flow over text nobody typed. */
export function truncateModelName(name: string) {
  return name.length <= MODEL_NAME_MAX_LENGTH
    ? name
    : name.slice(0, MODEL_NAME_MAX_LENGTH).trimEnd();
}
