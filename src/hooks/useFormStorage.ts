import { openConfirmModal } from '@mantine/modals';
import { useCallback, useEffect } from 'react';
import type { EventType, FieldPath, UseFormReturn } from 'react-hook-form';
import type * as z from 'zod';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';

/**
 * How long a persisted draft stays offerable.
 *
 * The modal offers "the unsaved changes from your previous session", which in practice means
 * hours to a few days — a week comfortably covers "I left this open Friday and came back
 * Monday". Before this, entries had NO expiry at all, so a draft could be replayed months
 * later; anything it points at by reference (an uploaded object key, a category, a tag) may
 * have been deleted in the meantime, and the user has long since forgotten the context they'd
 * be restoring. A bound is the point; the exact number is a judgement call, and the server
 * remains the authority on whether a restored reference is still valid.
 */
export const FORM_STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What actually goes in localStorage. Legacy entries are the bare value with no envelope. */
type StoredForm = { savedAt: number; value: unknown };

function isStoredForm(parsed: unknown): parsed is StoredForm {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as StoredForm).savedAt === 'number' &&
    'value' in parsed
  );
}

/**
 * Parse a persisted entry, dropping anything unusable or expired.
 *
 * Returns `null` (i.e. "offer nothing, clear the key") for: absent, unparseable, or older than
 * `ttlMs`. 🔴 An UNSTAMPED legacy entry is also treated as expired: it was written before
 * entries carried a write time, so its age is unknowable and cannot be bounded — and the whole
 * point of the TTL is that an unbounded-age draft is the hazard. The cost is one-time and
 * small (a draft that happened to be mid-flight across the deploy loses its restore offer).
 */
export function readStoredFormValue(
  raw: string | null,
  { now = Date.now(), ttlMs = FORM_STORAGE_TTL_MS }: { now?: number; ttlMs?: number } = {}
): { value: unknown } | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isStoredForm(parsed)) return null;
  if (!(now - parsed.savedAt < ttlMs)) return null;

  return { value: parsed.value };
}

export function serializeStoredFormValue(value: unknown, now = Date.now()) {
  return JSON.stringify({ savedAt: now, value } satisfies StoredForm);
}

/**
 * Per-field veto applied while merging a persisted draft over the form's CURRENT values.
 * Return `false` to keep the current value. Omitting it preserves the historical behaviour
 * exactly: every persisted key wins.
 */
export type ShouldRestoreField = (args: {
  name: string;
  storedValue: unknown;
  currentValue: unknown;
}) => boolean;

/**
 * Merge a persisted draft over the form's current values.
 *
 * 🔴 The merge direction is `{ ...current, ...stored }` — the persisted value wins. That is
 * correct for "restore my unsaved edits" and is kept as the DEFAULT, but it is also how a
 * persisted value silently clobbers server state it is a strictly less complete copy of. Opt
 * into `shouldRestoreField` (see `persistedValueLostIdentity`) on the fields where that matters
 * rather than changing the default for every form.
 */
export function mergeRestoredValues<T extends Record<string, unknown>>({
  current,
  stored,
  shouldRestoreField,
}: {
  current: T;
  stored: unknown;
  shouldRestoreField?: ShouldRestoreField;
}): T {
  if (typeof stored !== 'object' || stored === null) return current;

  const merged: Record<string, unknown> = { ...current };
  for (const [name, storedValue] of Object.entries(stored as Record<string, unknown>)) {
    // `merged[name] = ...` is a Set, so a stored `__proto__` key would hit the inherited
    // accessor instead of creating an own property (the spread this loop replaced could not).
    // Never a real form field; skip it rather than let it reshape the object.
    if (name === '__proto__') continue;
    if (
      shouldRestoreField &&
      !shouldRestoreField({ name, storedValue, currentValue: current[name] })
    ) {
      continue;
    }
    merged[name] = storedValue;
  }

  return merged as T;
}

function readId(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'number' ? id : null;
}

function readUrl(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const url = (value as { url?: unknown }).url;
  return typeof url === 'string' ? url : null;
}

/**
 * `true` when the persisted value is the SAME entity as the loaded one but has lost the
 * server-assigned `id`.
 *
 * This is the exact shape of the cover-image draft bug: an upload widget emits
 * `{ url, name }` with no `id`, that gets persisted, and on restore it overwrites the freshly
 * loaded `{ id, url, ... }` — so the server sees "a brand new image" for an object it already
 * has a row for, and re-creates (or fails to find) it.
 *
 * 🔴 Deliberately narrow: it only vetoes when the urls MATCH. If the user genuinely swapped in
 * a different image while offline, the persisted value has a different url, is a real edit, and
 * must still win — with the server-side existence check as the backstop if that new object is
 * gone.
 */
export function persistedValueLostIdentity(storedValue: unknown, currentValue: unknown) {
  const currentId = readId(currentValue);
  if (currentId == null) return false;
  if (readId(storedValue) != null) return false;

  const currentUrl = readUrl(currentValue);
  return currentUrl != null && currentUrl === readUrl(storedValue);
}

export function useFormStorage<TSchema extends z.ZodObject, TContext>({
  schema,
  timeout,
  form,
  key,
  watch,
  shouldRestoreField,
}: {
  schema: TSchema;
  timeout: number;
  form: UseFormReturn<z.input<TSchema>, TContext, z.output<TSchema>>;
  key: string;
  watch: (
    value: DeepPartial<z.input<TSchema>>,
    info: {
      name?: FieldPath<z.input<TSchema>>;
      type?: EventType;
    }
  ) => DeepPartial<z.input<TSchema>> | void;
  /** Opt-in per-field veto on restore. See `mergeRestoredValues`. */
  shouldRestoreField?: ShouldRestoreField;
}) {
  const debouncer = useDebouncer(timeout);

  useEffect(() => {
    const subscription = form.watch((value, info) => {
      const watchedValue = watch(value as any, info);
      if (!watchedValue) return;
      debouncer(() => {
        localStorage.setItem(key, serializeStoredFormValue(watchedValue));
      });
    });

    /**
     * assign a value to subscription immediately if there is no localstorage value
     * or assign a value to subscription after the user has closed the `restore-confirm` modal
     */
    const stored = readStoredFormValue(localStorage.getItem(key));
    if (!stored) {
      // Expired / unparseable / legacy: nothing offerable, so don't leave it to be re-read.
      localStorage.removeItem(key);
    } else {
      openConfirmModal({
        modalId: 'restore-confirm',
        centered: true,
        title: 'Restore unsaved changes?',
        children: 'Would you like to restore the unsaved changes from your previous session',
        labels: { cancel: `No`, confirm: `Yes` },
        closeOnConfirm: true,
        onClose: () => localStorage.removeItem(key),
        onConfirm: () => {
          const result = schema.safeParse(
            mergeRestoredValues({
              current: form.getValues() as Record<string, unknown>,
              stored: stored.value,
              shouldRestoreField,
            })
          );
          if (!result.success)
            showErrorNotification({ error: new Error('could not restore unsaved changes') });
          else form.reset(result.data as z.input<TSchema>);
        },
      });
    }

    return () => subscription.unsubscribe();
  }, [key]);

  return useCallback(() => localStorage.removeItem(key), [key]);
}
