/**
 * Content levels, build 3: what the text scan reads of an App Blocks shared document (the
 * `AppDoc` entity type), and how a rating id finds its document. Kept apart from
 * `doc-rater.service.ts` because the text scan's profile registry imports it: it reaches only the
 * store, never App Store or scan code.
 */
import type { DocForRating, RatedDocAddress } from '~/server/services/apps/doc-store';
import { getDocStoreRater } from '~/server/services/apps/doc-store-rater.instance';
import { collectSharedDataLeaves } from '~/server/services/apps/shared-data-leaves';
import type { TextScanField, TextScanSubject } from '~/server/services/text-scan/types';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const APP_DOC_ENTITY_TYPE = 'AppDoc' as const;

/** What a scanned subject carries, so a callback can find and bind the document it rated. */
export type AppDocSubjectMeta = RatedDocAddress & { seq: number; version: number };

/**
 * The text the scan reads of a document: each distinct string value and object key of its `data`,
 * one per line. When its data is too large or too deep to read leaf by leaf, its stored JSON text
 * instead (at most 64 KB, the document cap), so no document is left unratable.
 */
export function appDocTexts(data: unknown): string[] {
  const collected = collectSharedDataLeaves(data);
  if ('leaves' in collected) return collected.leaves.map((l) => l.raw);
  return [JSON.stringify(data)];
}

/** The scan's fields for a document's data: its texts, one per line. */
export function appDocFields(data: unknown): TextScanField[] {
  return [{ heading: 'Shared app content', text: appDocTexts(data).join('\n') }];
}

export function appDocTextScanSubject(
  address: RatedDocAddress,
  doc: DocForRating
): TextScanSubject {
  const meta: AppDocSubjectMeta = { ...address, seq: doc.seq, version: doc.version };
  return {
    fields: appDocFields(doc.data),
    // An author cannot rate their own document: any level found is the level.
    declared: {},
    ...(doc.authorUid !== null ? { userId: doc.authorUid } : {}),
    // A hidden document waits for a moderator, and a counter document holds no text.
    ...(doc.hidden || doc.authorKind === 'counter' ? { notPublic: true } : {}),
    meta,
  };
}

/** The scan subjects of these rating ids; a gone document is absent. */
export async function loadAppDocSubjects(ids: number[]): Promise<Map<number, TextScanSubject>> {
  const rater = getDocStoreRater();
  const out = new Map<number, TextScanSubject>();
  await limitConcurrency(
    ids.map((id) => async () => {
      const address = await rater.findByRatingId(id);
      if (!address) return;
      const doc = await rater.getForRating(
        address.appId,
        address.ns,
        address.collection,
        address.key
      );
      if (doc && doc.ratingId === id) out.set(id, appDocTextScanSubject(address, doc));
    }),
    5
  );
  return out;
}
