import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { HttpCaller } from '../httpCaller';
import type { Orchestrator } from './orchestrator.types';

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
export function getOrchestratorCaller(forTime?: Date) {
  return orchestratorCaller;
}
