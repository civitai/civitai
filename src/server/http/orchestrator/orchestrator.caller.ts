import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { HttpCaller } from '../httpCaller';
import type { Orchestrator } from './orchestrator.types';

// copyAsset is sent with `wait: true`, so the reply comes only after a large training asset has
// been copied, which can take minutes. It gets a longer abort deadline than HttpCaller's 120 s
// default so this signal never cuts a healthy copy short.
//
// The EFFECTIVE cap is 300 s, not this value: the response headers arrive only when the copy
// finishes, and Node's fetch (undici) gives up waiting for headers after its default
// `headersTimeout` of 300 s. A copy that takes longer fails with a headers timeout whatever this
// deadline says. Raising the cap would need a custom dispatcher, which is deliberately not used.
const COPY_ASSET_TIMEOUT_MS = 600_000;

class OrchestratorCaller extends HttpCaller {
  constructor(endpoint?: string, token?: string) {
    endpoint ??= env.ORCHESTRATOR_ENDPOINT;
    token ??= env.ORCHESTRATOR_ACCESS_TOKEN;
    if (!endpoint) throw new Error('Missing ORCHESTRATOR_ENDPOINT env');
    if (!token) throw new Error('Missing ORCHESTRATOR_ACCESS_TOKEN env');

    super(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  public copyAsset({
    payload,
    queryParams,
  }: {
    payload: Orchestrator.Training.CopyAssetJobPayload;
    queryParams?: Orchestrator.JobQueryParams;
  }) {
    return this.post<Orchestrator.Training.CopyAssetJobResponse>('/v1/consumer/jobs', {
      payload: { $type: 'copyAsset', ...payload },
      queryParams,
      timeout: COPY_ASSET_TIMEOUT_MS,
    });
  }

  public clearAssets({
    payload,
    queryParams,
  }: {
    payload: Orchestrator.Training.ClearAssetsJobPayload;
    queryParams?: Orchestrator.JobQueryParams;
  }) {
    return this.post<Orchestrator.Training.ClearAssetsJobResponse>('/v1/consumer/jobs', {
      payload: { $type: 'clearAssets', ...payload },
      queryParams,
    });
  }

  // public getBlob({ payload }: { payload: Orchestrator.Generation.BlobGetPayload }) {
  //   return this.post<Orchestrator.Generation.BlobGetResponse>('/v1/consumer/jobs', {
  //     payload: { $type: 'blobGet', ...payload },
  //   });
  // }

  // public deleteBlob({ payload }: { payload: Orchestrator.Generation.BlobActionPayload }) {
  //   return this.post<Orchestrator.Generation.BlobActionPayload>('/v1/consumer/jobs', {
  //     payload: { $type: 'blobDelete', ...payload },
  //   });
  // }

  public imageAutoTag({ payload }: { payload: Orchestrator.Training.ImageAutoTagJobPayload }) {
    return this.post<Orchestrator.Training.ImageAutoTagJobResponse>('/v1/consumer/jobs', {
      payload: { $type: 'mediaTagging', ...payload },
    });
  }

  public imageAutoCaption({
    payload,
  }: {
    payload: Orchestrator.Training.ImageAutoCaptionJobPayload;
  }) {
    return this.post<Orchestrator.Training.ImageAutoCaptionJobResponse>('/v1/consumer/jobs', {
      payload: { $type: 'mediaCaptioning', ...payload },
    });
  }

  // public getEventById({ id, take, descending }: Orchestrator.Events.QueryParams) {
  //   return this.get<Orchestrator.Events.GetResponse>(`/v1/producer/jobs/${id}/events`, {
  //     queryParams: { take, descending },
  //   });
  // }
  //
  // public getJobById({ id }: Orchestrator.JobQueryParams) {
  //   return this.get<Orchestrator.GetJobResponse>(`/v1/consumer/jobs/${id}`);
  // }

  // public bustModelCache({ modelVersionId }: Orchestrator.Generation.BustModelCache) {
  //   return this.delete('/v2/models/@civitai/' + modelVersionId);
  // }

  // public taintJobById({ id, payload }: { id: string; payload: Orchestrator.TaintJobByIdPayload }) {
  //   return this.put(`/v1/consumer/jobs/${id}`, { payload });
  // }

  // public deleteJobById({ id }: { id: string }) {
  //   return this.delete(`/v1/consumer/jobs/${id}?force=true`);
  // }
}

const orchestratorCaller = new OrchestratorCaller();
export default orchestratorCaller;

export const altOrchestratorCaller =
  env.ALT_ORCHESTRATION_ENDPOINT && env.ALT_ORCHESTRATION_TOKEN
    ? new OrchestratorCaller(env.ALT_ORCHESTRATION_ENDPOINT, env.ALT_ORCHESTRATION_TOKEN)
    : orchestratorCaller;

export function getOrchestratorCaller(forTime?: Date, force?: boolean) {
  if (force === true) return altOrchestratorCaller;

  if (forTime && env.ALT_ORCHESTRATION_TIMEFRAME) {
    const { start, end } = env.ALT_ORCHESTRATION_TIMEFRAME;
    if ((!start || forTime > start) && (!end || forTime < end)) {
      logToAxiom({
        name: 'orchestrator',
        type: 'info',
        message: `Using alt orchestrator caller: ${env.ALT_ORCHESTRATION_ENDPOINT}`,
      }).catch();
      return altOrchestratorCaller;
    }
  }
  return orchestratorCaller;
}
