import { del, get, set } from 'idb-keyval';
import { useEffect } from 'react';
import type { BatchComposerState, BatchComposerStore } from './batch-composer.store';
import type { ComposerDraft } from './batch-composer.utils';
import { isEmptyDraft, parseDraft, serializeDraft } from './batch-composer.utils';

const DRAFT_KEY = 'batch-composer:draft';
const SAVE_DELAY_MS = 400;

export function draftKey(userId: number): string {
  return `${DRAFT_KEY}:${userId}`;
}

export async function loadDraft(userId: number): Promise<ComposerDraft | null> {
  try {
    return parseDraft(await get(draftKey(userId)), new Date());
  } catch {
    return null;
  }
}

export async function saveDraft(userId: number, draft: ComposerDraft): Promise<void> {
  try {
    if (isEmptyDraft(draft)) await del(draftKey(userId));
    else await set(draftKey(userId), serializeDraft(draft));
  } catch {
    // Storage is a convenience: a private window or a full store must not break the composer.
  }
}

export async function clearDraft(userId: number): Promise<void> {
  try {
    await del(draftKey(userId));
  } catch {
    // See saveDraft.
  }
}

function toDraft(state: BatchComposerState): ComposerDraft {
  return {
    media: state.media.filter(
      (item) => item.status === 'added' && item.imageId !== undefined
    ) as ComposerDraft['media'],
    imagesPerPost: state.imagesPerPost,
    shared: state.shared,
    presetId: state.presetId,
    promotedNames: state.promotedNames,
    schedule: state.schedule,
    seed: state.seed,
    fixedDates: state.fixedDates,
  };
}

function draftChanged(state: BatchComposerState, previous: BatchComposerState): boolean {
  return (
    state.media !== previous.media ||
    state.imagesPerPost !== previous.imagesPerPost ||
    state.shared !== previous.shared ||
    state.presetId !== previous.presetId ||
    state.promotedNames !== previous.promotedNames ||
    state.schedule !== previous.schedule ||
    state.seed !== previous.seed ||
    state.fixedDates !== previous.fixedDates
  );
}

export function useDraftPersistence(store: BatchComposerStore, userId: number | undefined) {
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: ComposerDraft | null = null;
    let unsubscribe: (() => void) | undefined;

    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!pending) return;
      const draft = pending;
      pending = null;
      void saveDraft(userId, draft);
    };

    void loadDraft(userId).then((draft) => {
      if (cancelled) return;
      store.getState().hydrate(draft);
      unsubscribe = store.subscribe((state, previous) => {
        if (state.submitted || !draftChanged(state, previous)) return;
        pending = toDraft(state);
        clearTimeout(timer);
        timer = setTimeout(flush, SAVE_DELAY_MS);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      flush();
    };
  }, [store, userId]);
}
