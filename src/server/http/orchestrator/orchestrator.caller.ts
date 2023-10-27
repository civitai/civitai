import { env } from '~/env/server.mjs';
import { HttpCaller } from '../httpCaller';
import { Orchestrator } from './orchestrator.types';

class OrchestratorCaller extends HttpCaller {
  private static instance: OrchestratorCaller;

  protected constructor(baseUrl: string, options?: { headers?: MixedObject }) {
    super(baseUrl, options);
  }

  static getInstance(): OrchestratorCaller {
    if (!env.ORCHESTRATOR_ENDPOINT) throw new Error('Missing ORCHESTRATOR_ENDPOINT env');
    if (!env.ORCHESTRATOR_ACCESS_TOKEN) throw new Error('Missing ORCHESTRATOR_ACCESS_TOKEN env');

    if (!OrchestratorCaller.instance) {
      OrchestratorCaller.instance = new OrchestratorCaller(env.ORCHESTRATOR_ENDPOINT, {
        headers: { Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}` },
      });
    }

    return OrchestratorCaller.instance;
  }

  public textToImage({ payload }: { payload: Orchestrator.Generation.TextToImageJobPayload }) {
    return this.post<Orchestrator.Generation.TextToImageResponse>('/v1/consumer/jobs', {
      payload: { ...payload, $type: 'textToImage' },
    });
  }

  public copyAsset({ payload }: { payload: Orchestrator.Training.CopyAssetJobPayload }) {
    return this.post<Orchestrator.Training.CopyAssetJobResponse>('/v1/consumer/jobs', {
      payload: { ...payload, $type: 'copyAsset' },
    });
  }

  public clearAssets({ payload }: { payload: Orchestrator.Training.ClearAssetsJobPayload }) {
    return this.post<Orchestrator.Training.ClearAssetsJobResponse>('/v1/consumer/jobs', {
      payload: { ...payload, $type: 'clearAssets' },
    });
  }

  public getBlob({ payload }: { payload: Orchestrator.Generation.BlobGetPayload }) {
    return this.post<Orchestrator.Generation.BlobGetResponse>('/v1/consumer/jobs', {
      payload: { ...payload, $type: 'blobGet' },
    });
  }

  public deleteBlob({ payload }: { payload: Orchestrator.Generation.BlobActionPayload }) {
    return this.post<Orchestrator.Generation.BlobActionPayload>('/v1/consumer/jobs', {
      payload: { ...payload, $type: 'blobDelete' },
    });
  }

  public imageResourceTraining({
    payload,
  }: {
    payload: Orchestrator.Training.ImageResourceTrainingJobPayload;
  }) {
    return this.post<Orchestrator.Training.ImageResourceTrainingResponse>('/v1/consumer/jobs', {
      payload: { ...payload, $type: 'imageResourceTraining' },
    });
  }
}

export default OrchestratorCaller.getInstance();
