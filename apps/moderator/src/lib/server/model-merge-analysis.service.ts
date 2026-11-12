import {
  getWorkflow,
  queryWorkflows,
  submitWorkflow,
  type Workflow,
  type WorkflowTemplate,
} from '@civitai/orchestration-client';
import { dbRead } from './db';
import { getOrchestratorClient } from './orchestrator';
import {
  parseModelLink,
  type AnalysisState,
  type MergeAnalysis,
  type MergeAnalysisLabels,
  type MergeReport,
  type ModelRole,
  type ResolveResponse,
  type ResolvedVersion,
} from '$lib/model-merge-analysis';

/** Every workflow this page submits carries it; a read of anything without it is refused. */
const TAG = 'moderator:model-merge-analysis';
const ORCHESTRATOR_TIMEOUT_MS = 15_000;
const LORA_TYPES = new Set(['LORA', 'LoCon', 'DoRA']);
const MODEL_FILE_TYPES = new Set(['Model', 'Diffusion Model']);
const PRECISIONS = new Set(['fp32', 'fp16', 'bf16']);

const wrongType = (role: ModelRole) =>
  role === 'lora'
    ? 'This is not a LoRA. Paste the link to the LoRA you want to look for.'
    : 'This is not a checkpoint. Paste the link to the base or checkpoint model.';

type FileRow = { id: number; name: string; type: string; metadata: unknown };

/** The file the detector can read: a full-precision safetensors weights file, the primary one first. */
function analysableFile(files: FileRow[], fileId: number | undefined): FileRow | undefined {
  return files
    .filter((file) => {
      const metadata = (file.metadata ?? {}) as { fp?: unknown; primary?: unknown };
      return (
        MODEL_FILE_TYPES.has(file.type) &&
        (fileId === undefined || file.id === fileId) &&
        file.name.toLowerCase().endsWith('.safetensors') &&
        typeof metadata.fp === 'string' &&
        PRECISIONS.has(metadata.fp)
      );
    })
    .sort(
      (a, b) =>
        Number((b.metadata as { primary?: unknown })?.primary === true) -
        Number((a.metadata as { primary?: unknown })?.primary === true)
    )[0];
}

export async function resolveModelLink(input: string, role: ModelRole): Promise<ResolveResponse> {
  const link = parseModelLink(input);
  if ('error' in link) return link;

  let query = dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select([
      'm.id as modelId',
      'm.name as modelName',
      'm.type as modelType',
      'mv.id as versionId',
      'mv.name as versionName',
      'mv.baseModel',
    ])
    .where('m.status', '!=', 'Deleted')
    .where('mv.status', '!=', 'Deleted');
  if (link.versionId) query = query.where('mv.id', '=', link.versionId);
  else if (link.modelId) query = query.where('mv.modelId', '=', link.modelId);
  const versions = await query.orderBy('mv.index', 'asc').orderBy('mv.id', 'desc').execute();

  if (!versions.length)
    return {
      error: 'No model was found for this link. It may have been deleted, or the link is wrong.',
    };
  if (link.modelId && versions[0].modelId !== link.modelId)
    return {
      error: 'This version belongs to a different model. Copy its model-version link from Civitai.',
    };
  const type = versions[0].modelType;
  if (role === 'lora' ? !LORA_TYPES.has(type) : type !== 'Checkpoint')
    return { error: wrongType(role) };

  const files = await dbRead
    .selectFrom('ModelFile')
    .select(['id', 'name', 'type', 'metadata', 'modelVersionId'])
    .where(
      'modelVersionId',
      'in',
      versions.map((v) => v.versionId)
    )
    .where('replacedAt', 'is', null)
    .execute();

  return {
    versions: versions.map((v): ResolvedVersion => {
      const file = analysableFile(
        files.filter((f) => f.modelVersionId === v.versionId),
        link.fileId
      );
      return {
        modelId: v.modelId,
        modelName: v.modelName,
        versionId: v.versionId,
        versionName: v.versionName,
        baseModel: v.baseModel,
        fileName: file?.name ?? null,
        // The detector needs no ecosystem, and the dashboard's links send `unknown` too.
        air: file ? `urn:air:unknown:${role}:civitai:${v.modelId}@${v.versionId}+${file.id}` : null,
        problem: file
          ? null
          : 'This version has no file the analysis can read. Choose a version with an FP16, BF16 or FP32 safetensors file.',
      };
    }),
  };
}

export type AnalysisRequest = {
  baseModel: string;
  checkpoint: string;
  loras: { model: string; strength?: number }[];
  labels: MergeAnalysisLabels;
};

export async function submitMergeAnalysis(
  request: AnalysisRequest,
  moderatorId: number
): Promise<{ workflowId: string } | { error: string }> {
  const { data, error } = await submitWorkflow({
    client: getOrchestratorClient(),
    body: {
      tags: [TAG],
      metadata: { moderatorId, labels: request.labels },
      steps: [
        {
          $type: 'modelAnalysis',
          name: 'analysis',
          input: {
            baseModel: request.baseModel,
            checkpoint: request.checkpoint,
            loras: request.loras,
          },
        },
      ],
    } as unknown as WorkflowTemplate,
    signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
  });
  if (data?.id) return { workflowId: data.id };
  console.error('[merge-analysis] submit refused', error);
  return { error: 'The check could not be started. Try again shortly.' };
}

const stateOf = (status: string): AnalysisState =>
  status === 'succeeded'
    ? 'succeeded'
    : ['failed', 'expired', 'canceled'].includes(status)
    ? 'failed'
    : 'running';

type AnalysisStep = { output?: { report?: MergeReport; blob?: { url?: string | null } } | null };
const analysisStep = (workflow: Workflow) => workflow.steps?.[0] as AnalysisStep | undefined;

function toAnalysis(workflow: Workflow): MergeAnalysis {
  const output = analysisStep(workflow)?.output;
  const metadata = workflow.metadata as { labels?: MergeAnalysisLabels } | null;
  return {
    workflowId: workflow.id ?? '',
    createdAt: workflow.createdAt ? String(workflow.createdAt) : null,
    state: stateOf(String(workflow.status)),
    labels: metadata?.labels ?? null,
    report: output?.report ?? null,
    hasReportFile: !!output?.blob?.url,
  };
}

async function readTaggedWorkflow(workflowId: string): Promise<Workflow | null | undefined> {
  const { data, response } = await getWorkflow({
    client: getOrchestratorClient(),
    path: { workflowId },
    signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
  });
  if (data) return data.tags?.includes(TAG) ? data : null;
  return response?.status === 404 || response?.status === 400 ? null : undefined;
}

/** `null`: no such check. `undefined`: the orchestrator could not be asked. */
export async function readMergeAnalysis(workflowId: string) {
  const workflow = await readTaggedWorkflow(workflowId);
  return workflow ? toAnalysis(workflow) : workflow;
}

export async function recentMergeAnalyses(): Promise<MergeAnalysis[]> {
  const { data } = await queryWorkflows({
    client: getOrchestratorClient(),
    query: { tags: [TAG], take: 10 },
    signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
  });
  if (!data) throw new Error('The orchestrator did not answer the workflow query.');
  return (data.items ?? []).map(toAnalysis);
}

/** The original report file, fetched server-side so its signed address never reaches the browser. */
export async function fetchMergeReportFile(workflowId: string): Promise<Response | null> {
  const workflow = await readTaggedWorkflow(workflowId);
  const url = workflow && analysisStep(workflow)?.output?.blob?.url;
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  return res.ok ? res : null;
}
