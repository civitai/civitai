import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import {
  transferHuggingFaceImportSchema,
  getHuggingFaceImportsSchema,
} from '~/server/schema/huggingface-import.schema';
import { HuggingFaceError, parseHuggingFaceRepo } from '~/server/services/huggingface.service';
import {
  enqueueImports,
  getImportStatus,
  IMPORT_SYSTEM_USER_ID,
  resolveRepoForImport,
  reuseStoredFile,
} from '~/server/services/huggingface-import.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { filterFileTypeByExtension } from '~/utils/file-display-helpers';
import { zc } from '~/utils/schema-helpers';

/**
 * Server-side Hugging Face import, for our own tooling.
 *
 * POST — queue a repo's files onto a model version; one call can carry the whole model.
 *   { repo, revision?, modelVersionId, groupName?, userId?, files: [{ path, type }] }
 *   `userId` is attribution only and defaults to the system user.
 * GET `?id=<importId>`   — one import's progress.
 * GET `?repo=&revision=` — the repo's files with sizes, sha256, and whether we already store the sha.
 *
 * The transfer runs on the `process-huggingface-imports` cron and attaches each file when it lands,
 * so a caller polls `id` and makes no second call. A file whose sha256 we already store is attached
 * immediately instead — `reused: true`, with nothing to poll. Response shapes are whatever
 * `getImportStatus` and `resolveRepoForImport` select.
 *
 * 🔴 `type` is required per file and never inferred on POST. The GET's `suggestedType` is a hint for a
 * human and never names the primary weights, because a wrong type there is a version nothing loads.
 */
const getStatusSchema = z.object({ id: zc.numberString });
const getRepoSchema = getHuggingFaceImportsSchema
  .pick({ repo: true })
  .required({ repo: true })
  .extend({ revision: z.string().trim().min(1).optional() });

/** Hugging Face's own refusals are the caller's problem to fix, not a 500. */
async function resolveRepo(
  input: { repo: string; revision?: string },
  res: NextApiResponse
): Promise<Awaited<ReturnType<typeof resolveRepoForImport>> | null> {
  try {
    // Parsed first, exactly as the tRPC surface does it: a pasted repo URL — or a `/tree/<sha>` one
    // whose revision must be kept — is interpolated raw into the HF path otherwise, and comes back
    // as a 404 that reads like a missing repo.
    const target = parseHuggingFaceRepo(input.repo);
    if (!target) {
      res.status(400).json({ error: 'Could not read an owner/name out of that.' });
      return null;
    }
    // An explicit revision wins; otherwise a tree URL keeps the revision it names rather than
    // silently resolving to the default branch.
    return await resolveRepoForImport({
      repo: target.repo,
      revision: input.revision ?? target.revision,
    });
  } catch (error) {
    if (error instanceof HuggingFaceError) {
      res.status(400).json({ error: error.message });
      return null;
    }
    throw error;
  }
}

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `${req.method} not allowed` });
  }

  if (req.method === 'GET') {
    if (req.query.repo) {
      const query = getRepoSchema.safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: z.prettifyError(query.error) });
      const listed = await resolveRepo(query.data, res);
      if (!listed) return;
      return res.status(200).json(listed);
    }

    const query = getStatusSchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: z.prettifyError(query.error) });
    const status = await getImportStatus(query.data.id);
    if (!status) return res.status(404).json({ error: `No import with id ${query.data.id}.` });
    return res.status(200).json(status);
  }

  // `safeParse`, not `parse`: a thrown ZodError leaves this handler as an uncaught 500, and a
  // malformed body is the caller's mistake to read.
  const parsed = transferHuggingFaceImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  // Before the transfer, not after: an unknown version id otherwise costs hours of copying and then
  // fails at the attach, with the bytes already stored.
  const version = await dbRead.modelVersion.findUnique({
    where: { id: input.modelVersionId },
    select: { id: true },
  });
  if (!version)
    return res.status(400).json({ error: `No model version with id ${input.modelVersionId}.` });

  const repo = await resolveRepo(input, res);
  if (!repo) return;

  const available = new Set(repo.files.map((file) => file.path));
  const missing = input.files.filter((file) => !available.has(file.path)).map((file) => file.path);
  if (missing.length)
    return res.status(400).json({
      error: `Not in ${repo.repo} at ${repo.revision}: ${missing.join(', ')}`,
    });

  // The rule the upload UI applies, before a transfer that can run for hours.
  const mistyped = input.files.filter((file) => !filterFileTypeByExtension(file.type, file.path));
  if (mistyped.length)
    return res.status(400).json({
      error: mistyped.map((file) => `${file.path} cannot be "${file.type}"`).join('; '),
    });

  const userId = input.userId ?? IMPORT_SYSTEM_USER_ID;
  const inRepo = new Map(repo.files.map((file) => [file.path, file]));

  // Split on the sha Hugging Face already gave us: bytes we hold are attached now, the rest are
  // queued. A shared 10 GB text encoder is the difference between a transfer and nothing at all.
  const reused = new Map<string, { importId: number; modelFileId: number | null }>();
  for (const file of input.files) {
    const source = inRepo.get(file.path);
    // `existing` is a sha256 match, never a filename one: the same name carries different bytes in
    // different repos, and the wrong weights on a version are invisible until someone generates.
    if (!source?.existing) continue;
    reused.set(
      file.path,
      await reuseStoredFile({
        repo: repo.repo,
        revision: repo.revision,
        path: file.path,
        sizeBytes: source.size ?? null,
        sha256: source.sha256 ?? null,
        storedUrl: source.existing.url,
        modelVersionId: input.modelVersionId,
        type: file.type,
        userId,
        groupName: input.groupName,
      })
    );
  }

  const toTransfer = input.files.filter((file) => !reused.has(file.path));
  const { rows } = toTransfer.length
    ? await enqueueImports({
        repo,
        paths: toTransfer.map((file) => file.path),
        userId,
        groupName: input.groupName,
        attach: {
          modelVersionId: input.modelVersionId,
          types: Object.fromEntries(toTransfer.map((file) => [file.path, file.type])),
        },
      })
    : { rows: [] };

  const byPath = new Map(rows.map((row) => [row.filename, row]));
  return res.status(200).json({
    repo: repo.repo,
    revision: repo.revision,
    files: input.files.map((file) => {
      const alreadyStored = reused.get(file.path);
      if (alreadyStored)
        return {
          path: file.path,
          importId: alreadyStored.importId,
          status: 'Completed',
          modelFileId: alreadyStored.modelFileId,
          attachVersionId: input.modelVersionId,
          reused: true,
        };

      const row = byPath.get(file.path);
      return {
        path: file.path,
        importId: row?.id ?? null,
        status: row?.status ?? 'Unknown',
        modelFileId: row?.modelFileId ?? null,
        reused: false,
        // 🔴 Where the file is ACTUALLY headed. `(repo, revision, filename)` is unique, so a path
        // queued earlier keeps its original row and its original destination — this call did not
        // re-point it, and without this field a caller polling to `Completed` would conclude its
        // own version got the file.
        attachVersionId: row?.attachVersionId ?? null,
      };
    }),
  });
});
