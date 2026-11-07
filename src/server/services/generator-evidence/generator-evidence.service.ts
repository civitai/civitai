import { TRPCError } from '@trpc/server';
import plimit from 'p-limit';
import { dbRead, dbWrite } from '~/server/db/client';
import { createCsamReport } from '~/server/services/csam.service';
import { csamEvidenceStore } from '~/server/services/generator-evidence/evidence-store';
import { getViewedEvidence } from '~/server/services/generator-evidence/evidence-views';
import type { EvidenceJob, EvidenceRef } from '~/server/services/generator-evidence/evidence-refs';
import {
  collectWorkflowEvidence,
  refForSource,
  workflowOwnerId,
} from '~/server/services/generator-evidence/evidence-refs';
import type { OrchestratorConfig } from '~/server/services/generator-evidence/orchestrator-evidence';
import {
  getManagerWorkflow,
  listManagerWorkflows,
  orchestratorEvidenceConfig,
} from '~/server/services/generator-evidence/orchestrator-evidence';
import type {
  EvidenceStore,
  StoredEvidenceBlob,
} from '~/server/services/generator-evidence/preserve-blob';
import { preserveBlob } from '~/server/services/generator-evidence/preserve-blob';
import { CsamReportType } from '~/shared/utils/prisma/enums';
import type {
  GeneratorEvidenceDetails,
  StoredEvidenceJob,
  TriggerRef,
} from '~/server/services/generator-evidence/evidence-meta';
import type { AdoptableCopy } from '~/server/services/generator-evidence/evidence-manifest';
import {
  adoptCopy,
  parseManifest,
  readManifest,
} from '~/server/services/generator-evidence/evidence-manifest';
import { evidenceSizeProblem } from '~/server/services/generator-evidence/evidence-payload';
import { MAX_FILES_PER_PRESERVE, MAX_WORKFLOWS_PER_PRESERVE } from '~/server/schema/csam.schema';
import {
  evidenceVersion,
  GENERATOR_EVIDENCE_VERSION,
  generatorEvidenceReportWhere,
  isGeneratorEvidenceDetails,
} from '~/server/services/generator-evidence/evidence-meta';

export const GENERATOR_EVIDENCE_HOLD_REASON = 'generator evidence preserved for a CSAM report';

type TriggerRow = {
  prompt?: unknown;
  negativePrompt?: unknown;
  inputImages?: unknown;
  inputVideo?: unknown;
  time?: unknown;
};

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

function triggerJob(
  restrictionId: number,
  index: number,
  trigger: TriggerRow,
  orchestratorOrigin: string
): EvidenceJob {
  const sources = [
    ...(Array.isArray(trigger.inputImages) ? trigger.inputImages : []),
    trigger.inputVideo,
  ].filter((s): s is string => typeof s === 'string');
  const refs = sources
    .map((s) => refForSource(s, 'input', undefined, orchestratorOrigin))
    .filter((r): r is EvidenceRef => r !== null);
  return {
    jobId: `trigger:${restrictionId}:${index}`,
    source: 'trigger',
    restrictionId,
    prompt: str(trigger.prompt),
    negativePrompt: str(trigger.negativePrompt),
    dateTime: str(trigger.time),
    refs,
  };
}

/** The user's generation restrictions, triggers summarised; no file or URL leaves the server. */
export async function getEvidenceTriggers(userId: number) {
  const rows = await dbRead.userRestriction.findMany({
    where: { userId, type: 'generation' },
    select: { id: true, status: true, createdAt: true, triggers: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return rows.map((row) => ({
    restrictionId: row.id,
    status: row.status,
    createdAt: row.createdAt,
    triggers: (Array.isArray(row.triggers) ? (row.triggers as TriggerRow[]) : []).map(
      (trigger, index) => ({
        index,
        time: str(trigger?.time),
        prompt: str(trigger?.prompt),
        negativePrompt: str(trigger?.negativePrompt),
        inputCount:
          (Array.isArray(trigger?.inputImages) ? trigger.inputImages.length : 0) +
          (str(trigger?.inputVideo) ? 1 : 0),
      })
    ),
  }));
}

/** The user's recent workflows from the orchestrator's user-scoped listing, counted, never rendered. */
export async function getEvidenceWorkflows(userId: number, cursor?: string) {
  const config = orchestratorEvidenceConfig();
  const { items, next } = await listManagerWorkflows(config, userId, 50, cursor);
  const workflows = items.flatMap((item) => {
    const job = collectWorkflowEvidence(item, config.origin);
    if (!job || workflowOwnerId(job.jobId) !== userId) return [];
    const blobs = job.refs.filter((r) => r.kind === 'blob');
    return [
      {
        workflowId: job.jobId,
        createdAt: job.dateTime,
        prompt: job.prompt,
        inputs: job.refs.filter((r) => r.role === 'input').length,
        outputs: blobs.filter((r) => r.role === 'output').length,
        withheld: blobs.filter((r) => r.kind === 'blob' && r.blockedReason).length,
      },
    ];
  });
  return { workflows, next };
}

export type PreserveInput = {
  userId: number;
  moderatorId: number;
  workflowIds: string[];
  triggers: TriggerRef[];
  priorCTReports?: number[];
  /** A preserve run's manifest: its workflows and triggers are added, and its copies adopted. */
  manifestKey?: string;
};

export type PreserveDeps = { config: OrchestratorConfig; store: EvidenceStore; now?: () => Date };

async function loadJobs(deps: PreserveDeps, input: PreserveInput) {
  const jobs: EvidenceJob[] = [];
  const refused: { ref: string; reason: string }[] = [];

  const limit = plimit(4);
  const read = await Promise.all(
    [...new Set(input.workflowIds)].map((workflowId) =>
      limit(async (): Promise<{ workflowId: string; job?: EvidenceJob; reason?: string }> => {
        // The id is the orchestrator's and begins with its submitter; a posted id for anyone else is refused.
        if (workflowOwnerId(workflowId) !== input.userId)
          return { workflowId, reason: 'not a workflow of this user' };
        const workflow = await getManagerWorkflow(deps.config, workflowId);
        const job = workflow ? collectWorkflowEvidence(workflow, deps.config.origin) : null;
        if (!job || job.jobId !== workflowId)
          return { workflowId, reason: 'not found at the orchestrator' };
        return { workflowId, job };
      })
    )
  );
  for (const result of read)
    if (result.job) jobs.push(result.job);
    else refused.push({ ref: result.workflowId, reason: result.reason ?? 'not read' });

  const restrictionIds = [...new Set(input.triggers.map((t) => t.restrictionId))];
  const restrictions = restrictionIds.length
    ? await dbRead.userRestriction.findMany({
        where: { id: { in: restrictionIds }, userId: input.userId },
        select: { id: true, triggers: true },
      })
    : [];
  const byId = new Map(restrictions.map((r) => [r.id, r]));
  const seenTriggers = new Set<string>();
  for (const { restrictionId, index } of input.triggers) {
    const key = `${restrictionId}:${index}`;
    if (seenTriggers.has(key)) continue;
    seenTriggers.add(key);
    const restriction = byId.get(restrictionId);
    const triggers = Array.isArray(restriction?.triggers) ? restriction.triggers : [];
    const trigger = triggers[index] as TriggerRow | undefined;
    if (!restriction || !trigger || typeof trigger !== 'object') {
      refused.push({ ref: `restriction ${restrictionId} #${index}`, reason: 'not found' });
      continue;
    }
    jobs.push(triggerJob(restrictionId, index, trigger, deps.config.origin));
  }
  return { jobs, refused };
}

const jobKeyFor = (job: Pick<EvidenceJob, 'jobId' | 'source'>) =>
  job.source === 'workflow' ? job.jobId : job.jobId.replace(/:/g, '-');

/**
 * Preserves every file of the chosen workflows and triggers, then files them as a GeneratedImage report
 * that waits for a moderator's approval. Reports nobody: no strike, deny or account action follows.
 */
export async function preserveGeneratorEvidence(
  input: PreserveInput,
  deps: PreserveDeps = { config: orchestratorEvidenceConfig(), store: csamEvidenceStore() }
) {
  let copies = new Map<string, AdoptableCopy>();
  if (input.manifestKey) {
    const manifest = parseManifest(
      await readManifest(deps.store, input.manifestKey, input.userId),
      input.manifestKey,
      input.userId
    );
    copies = manifest.copies;
    input = {
      ...input,
      workflowIds: [...input.workflowIds, ...manifest.workflowIds],
      triggers: [...input.triggers, ...manifest.triggers],
    };
  }
  const workflowCount = new Set(input.workflowIds).size;
  if (workflowCount > MAX_WORKFLOWS_PER_PRESERVE)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This request covers ${workflowCount} workflows; at most ${MAX_WORKFLOWS_PER_PRESERVE} can be preserved at once. Preserve them in batches of ${MAX_WORKFLOWS_PER_PRESERVE} or fewer; filing a whole preserve run's manifest larger than that is not available yet.`,
    });
  const { jobs, refused } = await loadJobs(deps, input);
  const fileCount = jobs.reduce((n, job) => n + job.refs.length, 0);
  if (fileCount > MAX_FILES_PER_PRESERVE)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This request covers ${fileCount} files; at most ${MAX_FILES_PER_PRESERVE} can be preserved at once. Pick fewer workflows or triggers.`,
    });
  if (!jobs.length) return { reportId: null, refused, counts: {} as Record<string, number> };

  const pending = await dbWrite.csamReport.findFirst({
    where: generatorEvidenceReportWhere(input.userId),
    select: { details: true },
    orderBy: { id: 'asc' },
  });
  const kept = new Map<string, StoredEvidenceBlob>();
  if (isGeneratorEvidenceDetails(pending?.details))
    for (const job of pending.details.generatedImages ?? [])
      for (const blob of job.blobs ?? [])
        if (blob.status === 'preserved' || blob.status === 'excluded') kept.set(blob.blobId, blob);

  const limit = plimit(3);
  const stored: StoredEvidenceJob[] = [];
  for (const job of jobs) {
    const outputIds = job.refs.flatMap((r) =>
      r.kind === 'blob' && r.role === 'output' ? [r.blobId] : []
    );
    const blobs = await Promise.all(job.refs.map((ref) => limit(() => storedBlobFor(ref))));
    const { refs: _refs, ...rest } = job;
    stored.push({ ...rest, blobs });

    async function adoptFromManifest(ref: EvidenceRef & { kind: 'blob' }) {
      const copy = copies.get(ref.blobId);
      if (!copy) return null;
      const base = {
        blobId: ref.blobId,
        role: ref.role,
        ...(ref.stepName && { stepName: ref.stepName }),
      };
      return adoptCopy(deps.store, copy, base, input.moderatorId, deps.now?.() ?? new Date());
    }

    // The copy is the file's; the role, step and producing job are this workflow's use of it.
    function keptAs(ref: EvidenceRef & { kind: 'blob' }): StoredEvidenceBlob | undefined {
      const prior = kept.get(ref.blobId);
      if (!prior) return undefined;
      const {
        derivedOutputIds: _derived,
        stepName: _step,
        orchestratorJobId: _job,
        ...copy
      } = prior;
      return { ...copy, role: ref.role, ...(ref.stepName && { stepName: ref.stepName }) };
    }

    async function storedBlobFor(ref: EvidenceRef) {
      let blob: StoredEvidenceBlob;
      if (ref.kind === 'external')
        blob = {
          blobId: `external:${ref.host}${new URL(ref.url).pathname}`,
          role: ref.role,
          status: 'external',
          host: ref.host,
          ...(ref.stepName && { stepName: ref.stepName }),
        };
      else
        blob =
          keptAs(ref) ??
          (await adoptFromManifest(ref)) ??
          (await preserveBlob(deps, {
            userId: input.userId,
            jobKey: jobKeyFor(job),
            blobId: ref.blobId,
            role: ref.role,
            stepName: ref.stepName,
            blockedReason: ref.blockedReason,
            moderatorId: input.moderatorId,
          }));
      if (ref.kind === 'blob' && ref.orchestratorJobId)
        blob = { ...blob, orchestratorJobId: ref.orchestratorJobId };
      if (ref.role === 'input' && job.source === 'workflow' && outputIds.length)
        blob = { ...blob, derivedOutputIds: outputIds };
      return blob;
    }
  }

  const counts: Record<string, number> = {};
  for (const job of stored)
    for (const blob of job.blobs) counts[blob.status] = (counts[blob.status] ?? 0) + 1;

  const holdExists = await dbWrite.evidenceHold.findFirst({
    where: {
      userId: input.userId,
      role: 'manual',
      reason: GENERATOR_EVIDENCE_HOLD_REASON,
      releasedAt: null,
    },
    select: { id: true },
  });
  if (!holdExists)
    await dbWrite.evidenceHold.create({
      data: {
        userId: input.userId,
        role: 'manual',
        reason: GENERATOR_EVIDENCE_HOLD_REASON,
        createdById: input.moderatorId,
      },
    });

  const details: GeneratorEvidenceDetails = {
    generatedImages: stored,
    generatorEvidence: {
      version: GENERATOR_EVIDENCE_VERSION,
      ...(input.priorCTReports?.length && { priorCTReports: input.priorCTReports }),
    },
  };
  const report = await createCsamReport({
    userId: input.userId,
    reportedById: input.moderatorId,
    type: CsamReportType.GeneratedImage,
    details,
  });
  return { reportId: report.id, refused, counts };
}

/** The user's pending evidence report as the review page shows it: records only, never a file. */
export async function getGeneratorEvidenceReport(userId: number, viewerId: number) {
  // The primary: the approval this page leads to must name the files as they are now.
  const report = await dbWrite.csamReport.findFirst({
    where: generatorEvidenceReportWhere(userId),
    select: { id: true, createdAt: true, details: true, reportedById: true },
    orderBy: { id: 'asc' },
  });
  if (!report || !isGeneratorEvidenceDetails(report.details)) return null;
  const viewed = await getViewedEvidence(
    { id: report.id, userId },
    report.details.generatedImages.flatMap((j) => j.blobs)
  );
  return {
    id: report.id,
    createdAt: report.createdAt,
    version: evidenceVersion(report.details),
    meta: report.details.generatorEvidence,
    sendProblem: evidenceSizeProblem(report.details),
    jobs: report.details.generatedImages.map((job) => ({
      jobId: job.jobId,
      source: job.source,
      workflowId: job.workflowId,
      restrictionId: job.restrictionId,
      dateTime: job.dateTime,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      resources: job.resources,
      blobs: job.blobs.map((blob) => ({
        blobId: blob.blobId,
        role: blob.role,
        status: blob.status,
        reason: blob.excluded?.reason ?? blob.reason ?? blob.blockedReason,
        sha256: blob.sha256,
        bytes: blob.bytes,
        contentType: blob.contentType,
        refreshedAt: blob.refreshedAt,
        viewed: viewed.has(blob.blobId),
        viewedByMe: viewed.get(blob.blobId)?.includes(viewerId) ?? false,
      })),
    })),
  };
}

/** Releases the report to the send job, only as the moderator saw it: a report whose files changed
 *  since the page was read is not approved. */
export async function approveGeneratorEvidenceReport(input: {
  reportId: number;
  userId: number;
  moderatorId: number;
  version: string;
  priorCTReports?: number[];
}) {
  return dbWrite.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ details: unknown }[]>`
      SELECT details FROM "CsamReport"
      WHERE id = ${input.reportId} AND "userId" = ${input.userId}
        AND type = 'GeneratedImage' AND "reportSentAt" IS NULL AND "sendClaimId" IS NULL
      FOR UPDATE`;
    if (!locked || !isGeneratorEvidenceDetails(locked.details))
      throw new TRPCError({ code: 'CONFLICT', message: 'This report can no longer be approved.' });
    if (evidenceVersion(locked.details) !== input.version)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Files were added to this report since you loaded it. Reload and review them.',
      });
    const preserved = locked.details.generatedImages.some((job) =>
      job.blobs.some((blob) => blob.status === 'preserved')
    );
    if (!preserved)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No file of this report was preserved.',
      });
    const sendProblem = evidenceSizeProblem(locked.details);
    if (sendProblem) throw new TRPCError({ code: 'BAD_REQUEST', message: sendProblem });
    const details: GeneratorEvidenceDetails = {
      ...locked.details,
      generatorEvidence: {
        ...locked.details.generatorEvidence,
        ...(input.priorCTReports && {
          priorCTReports: [
            ...new Set([
              ...(locked.details.generatorEvidence.priorCTReports ?? []),
              ...input.priorCTReports,
            ]),
          ],
        }),
        approvedAt: new Date().toISOString(),
        approvedById: input.moderatorId,
      },
    };
    await tx.csamReport.update({ where: { id: input.reportId }, data: { details } });
    return { approved: true };
  });
}

type EvidenceFileAction = { reportId: number; userId: number; moderatorId: number; blobId: string };

/** Changes every use of one file in an unsent, unclaimed report. The report waits for a new approval. */
async function changeEvidenceFile(
  input: EvidenceFileAction,
  change: (blob: StoredEvidenceBlob) => StoredEvidenceBlob
) {
  return dbWrite.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ details: unknown }[]>`
      SELECT details FROM "CsamReport"
      WHERE id = ${input.reportId} AND "userId" = ${input.userId}
        AND type = 'GeneratedImage' AND "reportSentAt" IS NULL AND "sendClaimId" IS NULL
      FOR UPDATE`;
    if (!locked || !isGeneratorEvidenceDetails(locked.details))
      throw new TRPCError({ code: 'CONFLICT', message: 'This report can no longer be changed.' });
    let found = false;
    const generatedImages = locked.details.generatedImages.map((job) => ({
      ...job,
      blobs: job.blobs.map((blob) => {
        if (blob.blobId !== input.blobId) return blob;
        found = true;
        return change(blob);
      }),
    }));
    if (!found)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This report does not name that file.' });
    const details: GeneratorEvidenceDetails = {
      ...locked.details,
      generatedImages,
      generatorEvidence: {
        ...locked.details.generatorEvidence,
        approvedAt: null,
        approvedById: null,
      },
    };
    await tx.csamReport.update({ where: { id: input.reportId }, data: { details } });
    return { version: evidenceVersion(details) };
  });
}

/** Keeps one file out of what the report sends; its copy stays retained, and the reason is recorded. */
export async function excludeGeneratorEvidenceFile(input: EvidenceFileAction & { reason: string }) {
  const at = new Date().toISOString();
  return changeEvidenceFile(input, (blob) =>
    blob.status === 'excluded'
      ? blob
      : {
          ...blob,
          status: 'excluded',
          excluded: { reason: input.reason, byId: input.moderatorId, at, status: blob.status },
        }
  );
}

/**
 * Copies one file from the orchestrator again, to a new key, for a copy that no longer reads back as
 * recorded. The old copy is left where it is and named in `replaced`. A file the orchestrator no longer
 * gives up is left as it was.
 */
export async function recopyGeneratorEvidenceFile(
  input: EvidenceFileAction,
  deps: PreserveDeps = { config: orchestratorEvidenceConfig(), store: csamEvidenceStore() }
) {
  const report = await dbWrite.csamReport.findFirst({
    where: { id: input.reportId, ...generatorEvidenceReportWhere(input.userId) },
    select: { details: true },
  });
  if (!report || !isGeneratorEvidenceDetails(report.details))
    throw new TRPCError({ code: 'CONFLICT', message: 'This report can no longer be changed.' });
  const job = report.details.generatedImages.find((j) =>
    j.blobs.some((b) => b.blobId === input.blobId)
  );
  const blob = job?.blobs.find((b) => b.blobId === input.blobId);
  if (!job || !blob)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'This report does not name that file.' });
  if (blob.status === 'external' || blob.status === 'excluded')
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Only a generator file still in the report can be copied again.',
    });

  const now = deps.now?.() ?? new Date();
  const fresh = await preserveBlob(deps, {
    userId: input.userId,
    jobKey: `${jobKeyFor(job)}/recopy-${now.getTime()}`,
    blobId: input.blobId,
    role: blob.role,
    blockedReason: blob.blockedReason,
    moderatorId: input.moderatorId,
  });
  if (fresh.status !== 'preserved') return { status: fresh.status, reason: fresh.reason };

  const { version } = await changeEvidenceFile(input, (current) => {
    if (current.status === 'excluded')
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This file was excluded from the report while it was being copied.',
      });
    return {
      ...current,
      status: 'preserved',
      evidenceKey: fresh.evidenceKey,
      sha256: fresh.sha256,
      bytes: fresh.bytes,
      contentType: fresh.contentType,
      preservedAt: fresh.preservedAt,
      preservedById: fresh.preservedById,
      reason: undefined,
      blockedReason: undefined,
      refreshedAt: undefined,
      replaced: [
        ...(current.replaced ?? []),
        {
          status: current.status,
          evidenceKey: current.evidenceKey,
          sha256: current.sha256,
          at: now.toISOString(),
          byId: input.moderatorId,
        },
      ],
    };
  });
  return { status: fresh.status, version };
}
