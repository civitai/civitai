// The data half of the host seam ($lib/host): every read/write the flow UI performs, so the same
// components run against the SvelteKit shell (relative /api routes — $lib/shell-backend) or the
// web-component host (direct @civitai/client calls — $lib/element/backend).
import type { FromPrices, Media } from '$lib/data/trainingModels';
import type { GenerationItem, TrainingDetail, TrainingRow } from '$lib/data/trainingRows';
import type { TrainingRunInput } from '$lib/train-core';

export type { TrainingItem } from '$lib/train-core';
export type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';
import type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/autolabel-core';

/** One run's fully-resolved training config, as `submitTraining` sends it (the wire contract of the
 *  shell's POST /api/train): the core's `TrainingRunInput` minus the continue-only field, with the
 *  user's Review-step `currencies` choice required (validated at submit). */
export type TrainingRunPayload = Omit<TrainingRunInput, 'continueFrom' | 'currencies'> & {
  currencies: string[];
};

export interface StudioBackend {
  listTrainings(): Promise<TrainingRow[]>;
  getRunDetail(workflowId: string): Promise<TrainingDetail>;
  getRunDataset(workflowId: string): Promise<{ air: string; caption: string }[]>;
  /** One dataset image/video/audio blob. Blobs need auth (shell: the session-gated proxy; element: a
   *  Bearer fetch against the orchestrator), so views turn these into object URLs — a bare URL for a
   *  dataset blob is never browser-fetchable in the element. */
  datasetBlob(air: string, workflowId: string): Promise<Blob>;
  listGenerations(media: Media): Promise<GenerationItem[]>;
  /** Presigned blob upload target. The upload PUT/POST itself goes straight to the orchestrator
   *  ($lib/upload) — this only mints the URL. */
  uploadUrl(signal: AbortSignal): Promise<{ uploadUrl: string }>;
  autoLabelSubmit(
    items: AutoLabelItem[],
    mode: AutoLabelMode,
    media: Media
  ): Promise<{ workflowId: string }>;
  autoLabelPoll(
    workflowId: string,
    signal: AbortSignal
  ): Promise<{ done: boolean; results: AutoLabelResult[] }>;
  submitTraining(runs: TrainingRunPayload[]): Promise<string[]>;
  rename(workflowId: string, name: string): Promise<void>;
  continueQuote(
    workflowId: string,
    fromEpoch: number,
    addEpochs: number
  ): Promise<{ cost: number | null; steps?: number }>;
  continueRun(
    workflowId: string,
    fromEpoch: number,
    addEpochs: number,
    currencies?: string[]
  ): Promise<string>;
  /** The new-flow per-card "from" quotes. */
  getFromPrices(): Promise<FromPrices>;
  /** Spendable balances; null when unavailable (the header keeps its last value). */
  getBuzz(): Promise<{ yellow: number; green: number; blue: number } | null>;
}
