import { env } from '~/env/server.mjs';
import { logToAxiom } from '~/server/logging/client';
import { HttpCaller } from '../httpCaller';
import { Orchestrator } from './orchestrator.types';

class OrchestratorCaller extends HttpCaller {
  private static instance: OrchestratorCaller;

  protected constructor(baseUrl: string, options?: { headers?: MixedObject }) {
    super(baseUrl, options);
  }

  static getInstance(endpoint?: string, token?: string): OrchestratorCaller {
    endpoint ??= env.ORCHESTRATOR_ENDPOINT;
    token ??= env.ORCHESTRATOR_ACCESS_TOKEN;
    if (!endpoint) throw new Error('Missing ORCHESTRATOR_ENDPOINT env');
    if (!token) throw new Error('Missing ORCHESTRATOR_ACCESS_TOKEN env');

    if (!OrchestratorCaller.instance) {
      OrchestratorCaller.instance = new OrchestratorCaller(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    return OrchestratorCaller.instance;
  }

  public textToImage({ payload }: { payload: Orchestrator.Generation.TextToImageJobPayload }) {
    return this.post<Orchestrator.Generation.TextToImageResponse>('/v1/consumer/jobs', {
      payload: { $type: 'textToImage', ...payload },
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

  public getBlob({ payload }: { payload: Orchestrator.Generation.BlobGetPayload }) {
    return this.post<Orchestrator.Generation.BlobGetResponse>('/v1/consumer/jobs', {
      payload: { $type: 'blobGet', ...payload },
    });
  }

  public deleteBlob({ payload }: { payload: Orchestrator.Generation.BlobActionPayload }) {
    return this.post<Orchestrator.Generation.BlobActionPayload>('/v1/consumer/jobs', {
      payload: { $type: 'blobDelete', ...payload },
    });
  }

  public imageResourceTraining({
    payload,
  }: {
    payload: Orchestrator.Training.ImageResourceTrainingJobPayload;
  }) {
    return this.post<Orchestrator.Training.ImageResourceTrainingResponse>('/v1/consumer/jobs', {
      payload: { $type: 'imageResourceTraining', ...payload },
    });
  }

  public getEventById({ id, take, descending }: Orchestrator.Events.QueryParams) {
    return this.get<Orchestrator.Events.GetResponse>(`/v1/producer/jobs/${id}/events`, {
      queryParams: { take, descending },
    });
  }

  public getJobById({ id }: Orchestrator.JobQueryParams) {
    return this.get<Orchestrator.GetJobResponse>(`/v1/consumer/jobs/${id}`);
  }

  public prepareModel({ payload }: { payload: Orchestrator.Generation.PrepareModelPayload }) {
    return this.post<Orchestrator.Generation.PrepareModelResponse>('/v1/consumer/jobs', {
      payload: { $type: 'prepareModel', ...payload },
    });
  }
}

const orchestratorCaller = OrchestratorCaller.getInstance();
export default orchestratorCaller;

export const altOrchestratorCaller =
  env.ALT_ORCHESTRATION_ENDPOINT && env.ALT_ORCHESTRATION_TOKEN
    ? OrchestratorCaller.getInstance(env.ALT_ORCHESTRATION_ENDPOINT, env.ALT_ORCHESTRATION_TOKEN)
    : orchestratorCaller;

export function getOrchestratorCaller(forTime?: Date) {
  if (forTime && env.ALT_ORCHESTRATION_TIMEFRAME) {
    const { start, end } = env.ALT_ORCHESTRATION_TIMEFRAME;
    if ((!start || forTime > start) && (!end || forTime < end)) {
      logToAxiom({ name: 'orchestrator', type: 'info', message: 'Using alt orchestrator caller' });
      return altOrchestratorCaller;
    }
  }
  return orchestratorCaller;
}
