import { env } from '~/env/server.mjs';
import { logToAxiom } from '~/server/logging/client';
import { HttpCaller } from '../httpCaller';
import { Orchestrator } from './orchestrator.types';

const dryRunParam = 'whatif';

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

  public textToImage({
    payload,
    isTestRun = false,
  }: {
    payload: Omit<Orchestrator.Generation.TextToImageJobPayload, 'type'>;
    isTestRun?: boolean;
  }) {
    return this.post<Orchestrator.Generation.TextToImageResponse>(
      `/v1/consumer/jobs${isTestRun ? '?whatif=true' : undefined}`,
      {
        // TODO.Orchestrator: Timeout is a temporary measure - Remove once Koen approves of it.
        payload: { $type: 'textToImage', timeout: '00:05:00', ...payload },
      }
    );
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

  public imageResourceTrainingDryRun({
    payload,
  }: {
    payload: Orchestrator.Training.ImageResourceTrainingJobDryRunPayload;
  }) {
    return this.post<Orchestrator.Training.ImageResourceTrainingResponse>(
      `/v1/consumer/jobs?${dryRunParam}=true`,
      {
        payload: { $type: 'imageResourceTraining', ...payload },
      }
    );
  }

  public imageAutoTag({ payload }: { payload: Orchestrator.Training.ImageAutoTagJobPayload }) {
    return this.post<Orchestrator.Training.ImageAutoTagJobResponse>('/v1/consumer/jobs', {
      payload: { $type: 'mediaTagging', ...payload },
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

  public bustModelCache({ modelVersionId }: Orchestrator.Generation.BustModelCache) {
    return this.delete('/v2/models/@civitai/' + modelVersionId);
  }

  public taintJobById({ id, payload }: { id: string; payload: Orchestrator.TaintJobByIdPayload }) {
    return this.put(`/v1/consumer/jobs/${id}`, { payload });
  }

  public deleteJobById({ id }: { id: string }) {
    return this.delete(`/v1/consumer/jobs/${id}`);
  }
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
        message: `Using alt orchestrator caller: ${env.ALT_ORCHESTRATION_ENDPOINT} - ${env.ALT_ORCHESTRATION_TOKEN}`,
      });
      return altOrchestratorCaller;
    }
  }
  return orchestratorCaller;
}
