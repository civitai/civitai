import {
  getWorkflow,
  queryWorkflows,
  submitWorkflow,
  type ModelAnalysisInput,
  type ModelAnalysisStep,
  type ModelAnalysisStepTemplate,
  type Workflow,
} from '@civitai/orchestration-client';
import { dbRead } from './db';
import { getOrchestratorClient, isGoneStatus } from './orchestrator';
import {
  mergeAir,
  parseModelLink,
  type AnalysisState,
  type MergeAnalysis,
  type MergeAnalysisLabels,
  type ModelRole,
  type ResolveResponse,
  type ResolvedVersion,
} from '$lib/model-merge-analysis';

/** Every workflow this page submits carries it; a read of anything without it is refused. */
const TAG = 'moderator:model-merge-analysis';
const ORCHESTRATOR_TIMEOUT_MS = 15_000;
const LORA_TYPES = new Set(['LORA', 'LoCon', 'DoRA']);
// Ranked: a version's full file is preferred over its pruned one.
const MODEL_FILE_TYPES = ['Model', 'Diffusion Model', 'Pruned Model'];
const PRECISIONS = new Set(['fp32', 'fp16', 'bf16']);

export const isWorkflowId = (value: string) => /^[\w-]{1,100}$/.test(value);

const wrongType = (role: ModelRole) =>
  role === 'lora'
    ? 'This is not a LoRA. Paste the link to the LoRA you want to look for.'
    : 'This is not a checkpoint. Paste the link to the base or checkpoint model.';

type FileRow = { id: number; name: string; type: string; metadata: unknown };

const isPrimary = (file: FileRow) =>
  (file.metadata as { primary?: unknown } | null)?.primary === true;

/** The file the detector can read: a full-precision safetensors weights file, the primary one first. */
function analysableFile(files: FileRow[], fileId: number | undefined): FileRow | undefined {
  return files
    .filter((file) => {
      const metadata = (file.metadata ?? {}) as { fp?: unknown };
      return (
        MODEL_FILE_TYPES.includes(file.type) &&
        (fileId === undefined || file.id === fileId) &&
        file.name.toLowerCase().endsWith('.safetensors') &&
        typeof metadata.fp === 'string' &&
        PRECISIONS.has(metadata.fp)
      );
    })
    .sort(
      (a, b) =>
        Number(isPrimary(b)) - Number(isPrimary(a)) ||
        MODEL_FILE_TYPES.indexOf(a.type) - MODEL_FILE_TYPES.indexOf(b.type)
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
    .selectFrom('ModelFile as mf')
    .leftJoin('ModelFileHash as h', (join) =>
      join.onRef('h.fileId', '=', 'mf.id').on('h.type', '=', 'SHA256')
    )
    .select(['mf.id', 'mf.name', 'mf.type', 'mf.metadata', 'mf.modelVersionId', 'h.hash'])
    .where(
      'mf.modelVersionId',
      'in',
      versions.map((v) => v.versionId)
    )
    .where('mf.replacedAt', 'is', null)
    .execute();

  return {
    versions: versions.map((v): ResolvedVersion => {
      const versionFiles = files.filter((f) => f.modelVersionId === v.versionId);
      const file = analysableFile(versionFiles, link.fileId);
      return {
        modelId: v.modelId,
        modelName: v.modelName,
        versionId: v.versionId,
        versionName: v.versionName,
        baseModel: v.baseModel,
        fileName: file?.name ?? null,
        air: file ? mergeAir(role, v.modelId, v.versionId, file.id) : null,
        sha256: (file && versionFiles.find((f) => f.id === file.id)?.hash) ?? null,
        problem: file
          ? null
          : 'This version has no file the analysis can read. Choose a version with an FP16, BF16 or FP32 safetensors file.',
      };
    }),
  };
}

export type AnalysisRequest = ModelAnalysisInput & { labels: MergeAnalysisLabels };

export async function submitMergeAnalysis(
  { labels, ...input }: AnalysisRequest,
  moderatorId: number
): Promise<{ workflowId: string } | { error: string }> {
  const step: ModelAnalysisStepTemplate = { $type: 'modelAnalysis', name: 'analysis', input };
  const { data, error, response } = await submitWorkflow({
    client: getOrchestratorClient(),
    body: { tags: [TAG], metadata: { moderatorId, labels }, steps: [step] },
    signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
  });
  if (data?.id) return { workflowId: data.id };
  console.error('[merge-analysis] submit refused', error);
  // No response is a timeout or transport failure: the orchestrator may have accepted it anyway.
  return {
    error: response
      ? 'The check could not be started. Try again shortly.'
      : 'No answer from the orchestrator; the check may have started. Look under Recent checks before trying again.',
  };
}

const stateOf = (status: string): AnalysisState =>
  status === 'succeeded'
    ? 'succeeded'
    : ['failed', 'expired', 'canceled'].includes(status)
    ? 'failed'
    : 'running';

const analysisOutput = (workflow: Workflow) =>
  (workflow.steps?.[0] as ModelAnalysisStep | undefined)?.output;

function toAnalysis(workflow: Workflow): MergeAnalysis {
  const output = analysisOutput(workflow);
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
  return response && (isGoneStatus(response.status) || response.status === 400) ? null : undefined;
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
  const url = workflow && analysisOutput(workflow)?.blob?.url;
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  return res.ok ? res : null;
}
