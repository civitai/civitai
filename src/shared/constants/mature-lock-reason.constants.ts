export type MatureLockField = 'name' | 'description';

/** Fixed owner-facing wording per category; the filter's own output never reaches the owner. */
const MATURE_LOCK_CATEGORY_SENTENCES = {
  'mature-language': (field: string) =>
    `Words in this model's ${field} matched our mature-content filter, so the model is marked mature.`,
} as const;

export type MatureLockCategory = keyof typeof MATURE_LOCK_CATEGORY_SENTENCES;
export const MATURE_LOCK_DEFAULT_CATEGORY: MatureLockCategory = 'mature-language';

export const isMatureLockCategory = (value: unknown): value is MatureLockCategory =>
  typeof value === 'string' && Object.hasOwn(MATURE_LOCK_CATEGORY_SENTENCES, value);

/** What the owner of a model the save-time text filter marked mature is told about it. */
export type MatureLockReason = { fields: MatureLockField[]; category: MatureLockCategory };

/** Stored server-side on the lock marker: the reason plus a hash of the text it was read from. */
export type MatureLockAttribution = MatureLockReason & { textHash: string };

// A Record, so adding a key to MatureLockAttribution without listing it here fails to compile.
const ATTRIBUTION_KEYS = { fields: true, category: true, textHash: true } satisfies Record<
  keyof MatureLockAttribution,
  true
>;
/** Every key the attribution adds to the lock marker, for removing it. */
export const MATURE_LOCK_ATTRIBUTION_KEYS = Object.keys(ATTRIBUTION_KEYS);

export function matureLockReasonSentence({ fields, category }: MatureLockReason) {
  const field =
    fields.includes('name') && fields.includes('description')
      ? 'name and description'
      : fields.includes('name')
      ? 'name'
      : 'description';
  return MATURE_LOCK_CATEGORY_SENTENCES[category](field);
}
