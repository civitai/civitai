import type { APIRequestContext } from '@playwright/test';
import { many, one } from './db';
import { trpcMutation, trpcQuery } from './trpc';

const PG = 1;
const ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };
const p = (text: string) => `<p>${text.replace(/[<>&]/g, (c) => ESCAPES[c])}</p>`;

export async function createArticle(api: APIRequestContext, text: string) {
  const r = await trpcMutation<{ id: number }>(api, 'article.upsert', {
    title: `e2e article ${Date.now()}`,
    content: p(text),
    userNsfwLevel: PG,
  });
  return r.id;
}

export async function editArticle(api: APIRequestContext, id: number, text: string) {
  const row = (await one<{ title: string }>(`SELECT title FROM "Article" WHERE id = $1`, [id]))!;
  await trpcMutation(api, 'article.upsert', {
    id,
    title: row.title,
    content: p(text),
    userNsfwLevel: PG,
  });
}

export async function createPost(api: APIRequestContext, text: string) {
  return (
    await trpcMutation<{ id: number }>(api, 'post.create', { title: 'e2e post', detail: p(text) })
  ).id;
}

export async function editPost(api: APIRequestContext, id: number, text: string) {
  await trpcMutation(api, 'post.update', { id, detail: p(text) });
}

export async function createModel(api: APIRequestContext, text: string) {
  return (
    await trpcMutation<{ id: number }>(api, 'model.upsert', {
      name: `e2e model ${Date.now()}`,
      description: p(text),
      type: 'LORA',
      uploadType: 'Created',
      status: 'Draft',
    })
  ).id;
}

type ModelEditableRow = {
  name: string;
  type: string;
  uploadType: string;
  status: string;
  poi: boolean;
  nsfw: boolean;
  minor: boolean;
  sfwOnly: boolean;
  lockedProperties: string[];
};

/**
 * Resends the flags the edit form always sends: `modelUpsertSchema` defaults an omitted
 * `minor`/`sfwOnly` to false, so leaving them out would clear a scan's flag as a side effect.
 */
export async function editModel(api: APIRequestContext, id: number, text: string) {
  const row = (await one<ModelEditableRow>(
    `SELECT name, type, "uploadType", status, poi, nsfw, minor, "sfwOnly", "lockedProperties"
     FROM "Model" WHERE id = $1`,
    [id]
  ))!;
  await trpcMutation(api, 'model.upsert', { id, ...row, description: p(text) });
}

export async function seedModelVersion(modelId: number) {
  const r = (await one<{ id: number }>(
    `INSERT INTO "ModelVersion" ("modelId", name, "baseModel") VALUES ($1, 'v1', 'SDXL 1.0') RETURNING id`,
    [modelId]
  ))!;
  return r.id;
}

export async function publishSeededModel(modelId: number) {
  await many(
    `UPDATE "Model" SET status = 'Published', "publishedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [modelId]
  );
  await many(
    `UPDATE "ModelVersion" SET status = 'Published', "publishedAt" = now() AT TIME ZONE 'UTC' WHERE "modelId" = $1`,
    [modelId]
  );
}

export async function createCommentV2(
  api: APIRequestContext,
  on: { entityType: 'article'; entityId: number },
  text: string
) {
  return (await trpcMutation<{ id: number }>(api, 'commentv2.upsert', { ...on, content: p(text) }))
    .id;
}

export async function createComment(api: APIRequestContext, modelId: number, text: string) {
  return (await trpcMutation<{ id: number }>(api, 'comment.upsert', { modelId, content: p(text) }))
    .id;
}

export async function createResourceReview(
  api: APIRequestContext,
  modelId: number,
  modelVersionId: number,
  text: string
) {
  return (
    await trpcMutation<{ id: number }>(api, 'resourceReview.create', {
      modelId,
      modelVersionId,
      rating: 5,
      recommended: true,
      details: p(text),
    })
  ).id;
}

export async function setProfileBio(api: APIRequestContext, userId: number, text: string) {
  await trpcMutation(api, 'userProfile.update', { userId, bio: text });
}

export async function renameUser(api: APIRequestContext, userId: number, username: string) {
  await trpcMutation(api, 'user.update', { id: userId, username });
}

/** `createChat` requires the caller among `userIds` (chat.controller `createChatHandler`). */
export async function createChatWithMessage(
  api: APIRequestContext,
  selfId: number,
  otherUserId: number,
  text: string
) {
  const chat = await trpcMutation<{ id: number }>(api, 'chat.createChat', {
    userIds: [selfId, otherUserId],
  });
  const msg = await trpcMutation<{ id: number }>(api, 'chat.createMessage', {
    chatId: chat.id,
    content: text,
  });
  return { chatId: chat.id, messageId: msg.id };
}

export async function getBounty(api: APIRequestContext, id: number) {
  return trpcQuery<Record<string, unknown>>(api, 'bounty.getById', { id });
}

/**
 * Moderator session only, and gated on `challengePlatform`: the app needs
 * `FLIPT_LOCAL_OVERRIDES=challenge-platform-enabled=on` alongside the text-scan overrides.
 */
export async function rescanChallenge(moderatorApi: APIRequestContext, id: number) {
  await trpcMutation(moderatorApi, 'challenge.rescan', { id });
}
