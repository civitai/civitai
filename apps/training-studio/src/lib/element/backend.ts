// The web-component's StudioBackend: the browser-direct half of the contract in
// docs/training-studio-web-component.md. Every call runs with a freshly-minted host token and talks
// to the orchestrator with the client-safe cores — no server routes involved.
import { createCivitaiClient } from '@civitai/client';
import type { StudioBackend } from '$lib/backend';
import type { StudioLocation } from '$lib/host';
import { UploadError } from '$lib/upload';
import { computeFromPrices } from '$lib/pricing-core';
import * as label from '$lib/autolabel-core';
import * as orch from '$lib/orchestrator-core';
import type { OrchestratorClient } from '$lib/orchestrator-core';
import * as train from '$lib/train-core';

/** What an embedding page must inject into <civitai-training-studio> (as a JS property, never an
 *  attribute — it carries a credential provider). */
export interface StudioElementHost {
  /** Called per request and again after a 401 — the host mints server-side and returns the raw token. */
  getOrchestratorToken(): Promise<string>;
  /** Spendable balances for the pricing UI; omit (or resolve null) to hide balances. */
  getBuzzBalances?(): Promise<{ yellow: number; green: number; blue: number } | null>;
  config: {
    orchestratorEndpoint: string;
    orchestratorMode?: 'dev' | 'prod';
    imageLocation?: string | null;
    /** Opt training jobs into the NDJSON live trace (`events` or `logs`); off when omitted. */
    traceMode?: string;
  };
  hrefFor(loc: StudioLocation): string;
  navigate(loc: StudioLocation, opts?: { refreshAll?: boolean }): Promise<void>;
}

class UnauthorizedError extends Error {}

export function elementBackend(host: StudioElementHost): StudioBackend {
  // Orchestrator tokens are short-lived and a watched training outlives them, so a 401 anywhere in a
  // call gets ONE re-mint (host.getOrchestratorToken) + re-run before the failure surfaces. The cores
  // throw plain Errors with the status stripped; the interceptor is how a 401 stays detectable here.
  const call = async <T>(
    fn: (client: OrchestratorClient, token: string) => Promise<T>
  ): Promise<T> => {
    const attempt = async (): Promise<{ value: T } | { err: unknown; unauthorized: boolean }> => {
      const token = await host.getOrchestratorToken();
      const client = createCivitaiClient({
        baseUrl: host.config.orchestratorEndpoint,
        env: host.config.orchestratorMode === 'dev' ? 'dev' : 'prod',
        auth: token,
      });
      let unauthorized = false;
      client.interceptors.response.use((res) => {
        if (res.status === 401) unauthorized = true;
        return res;
      });
      try {
        return { value: await fn(client, token) };
      } catch (err) {
        return { err, unauthorized: unauthorized || err instanceof UnauthorizedError };
      }
    };
    const first = await attempt();
    if ('value' in first) return first.value;
    if (!first.unauthorized) throw first.err;
    const retried = await attempt();
    if ('value' in retried) return retried.value;
    throw retried.err;
  };

  const submitOpts = (): train.SubmitOptions => ({
    // No signal callbacks: the element runs on polling alone (signalsEndpoint is null there).
    traceMode: host.config.traceMode ?? 'events',
  });

  return {
    listTrainings: () => call((client) => orch.listTrainingWorkflows(client)),

    getRunDetail: (workflowId) =>
      call(async (client) => {
        const detail = await orch.getTrainingWorkflow(client, workflowId);
        if (!detail) throw new Error('Training not found.');
        return detail;
      }),

    getRunDataset: (workflowId) => call((client) => orch.getRunDataset(client, workflowId)),

    datasetBlob: (air, workflowId) =>
      call(async (_client, token) => {
        const res = await fetch(
          orch.consumerBlobUrl(host.config.orchestratorEndpoint, air, workflowId),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (res.status === 401) throw new UnauthorizedError(`Dataset image unavailable (401)`);
        if (!res.ok) throw new Error(`Dataset image unavailable (${res.status})`);
        return res.blob();
      }),

    listGenerations: (media) => call((client) => orch.listGenerations(client, media)),

    uploadUrl: async () => {
      try {
        return await call((client) => orch.blobUploadUrl(client));
      } catch (err) {
        // $lib/upload reads status/permanent off UploadError; a presign failure is always retryable.
        throw new UploadError(
          0,
          err instanceof Error ? err.message : 'Could not start the upload.'
        );
      }
    },

    autoLabelSubmit: (items, mode, media) =>
      call(async (client) => ({
        workflowId: await label.submitAutoLabel(client, mode, media, items),
      })),

    autoLabelPoll: (workflowId) => call((client) => label.pollAutoLabel(client, workflowId)),

    submitTraining: (runs) =>
      call((client) => train.submitTrainingBatch(client, runs, submitOpts())),

    rename: (workflowId, name) => call((client) => train.renameTraining(client, workflowId, name)),

    continueQuote: (workflowId, fromEpoch, addEpochs) =>
      call((client) =>
        train.continueTrainingWhatIf(client, { workflowId, fromEpoch, addEpochs }, submitOpts())
      ),

    continueRun: (workflowId, fromEpoch, addEpochs, currencies) =>
      call((client) =>
        train.continueTraining(
          client,
          { workflowId, fromEpoch, addEpochs, currencies },
          submitOpts()
        )
      ),

    getFromPrices: () => call((client) => computeFromPrices(client)),

    getBuzz: async () => (host.getBuzzBalances ? host.getBuzzBalances() : null),
  };
}
