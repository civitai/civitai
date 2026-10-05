import { getModeratorDb } from './moderator-db';
import { recordModActivity } from './mod-activity';

// Ticket 868mb8h0y. Attribution is free text, exactly as on `UserNotes`: imported rows carry Retool
// display names, new rows carry the Civitai username, and nothing joins on the column.
//
// 🔴 So `isMine` — which is also the edit authorisation — is a NAME COMPARISON, and some Retool names
// equal a current moderator's username, making those imported rows theirs to edit. Counts:
// docs/moderator-app/retool-db-cutover.md.
//
// The table has no `updatedAt`, so a rewritten note keeps its original byline and date — which is why
// both writes below record to `ModActivity`, the only trace an edit leaves.

export type ModelNote = {
  id: number;
  content: string;
  createdBy: string;
  createdAt: Date;
  /** UI advice only — the update re-checks the author in SQL. */
  isMine: boolean;
};

export async function getModelNotes(modelId: number, viewer: string | null): Promise<ModelNote[]> {
  const rows = await getModeratorDb()
    .selectFrom('ModelNotes')
    .select(['id', 'content', 'createdBy', 'createdAt'])
    .where('modelId', '=', modelId)
    .orderBy('createdAt', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, isMine: !!viewer && r.createdBy === viewer }));
}

export async function addModelNote(input: {
  modelId: number;
  content: string;
  author: string;
  moderatorId: number;
}): Promise<void> {
  await getModeratorDb()
    .insertInto('ModelNotes')
    .values({ modelId: input.modelId, content: input.content, createdBy: input.author })
    .execute();

  await recordModActivity({
    userId: input.moderatorId,
    entityType: 'model',
    entityId: input.modelId,
    activity: 'addNote',
  });
}

// The `createdBy` predicate is the authorisation check, not just a filter — a forged id changes
// nothing.
export async function updateModelNote(input: {
  id: number;
  content: string;
  author: string;
  moderatorId: number;
}): Promise<boolean> {
  // `RETURNING` rather than a row count: the audit row must name the model the note is filed against,
  // not one the client claimed.
  const updated = await getModeratorDb()
    .updateTable('ModelNotes')
    .set({ content: input.content })
    .where('id', '=', input.id)
    .where('createdBy', '=', input.author)
    .returning('modelId')
    .executeTakeFirst();

  if (!updated) return false;

  await recordModActivity({
    userId: input.moderatorId,
    entityType: 'model',
    entityId: updated.modelId,
    activity: 'editNote',
  });
  return true;
}
