import {
  RequestInfo as GeneratedRequestInfo,
  JobInfo as GeneratedJobInfo,
  TextToImageJob,
  ImageResourceTrainingJob,
} from '@civitai/client';

type RequestType = 'textToImage' | 'imageResourceTraining';

type RequestInfoMap = {
  textToImage: { details?: TextToImageJob; result: { blobKey: string; available?: boolean } };
  imageResourceTraining: { details?: ImageResourceTrainingJob; result: unknown };
};

type RequestInfo<T extends RequestType> = Omit<GeneratedRequestInfo, 'jobs'> & {
  jobs?: Array<JobInfo<T>>;
};
type JobInfo<T extends RequestType> = Omit<GeneratedJobInfo, 'details' | 'result'> &
  RequestInfoMap[T];

export type TextToImageResponse = RequestInfo<'textToImage'>;
export type ImageResourceTrainingResponse = RequestInfo<'textToImage'>;
