export type ImageProcessingStatus = 'processing' | 'nsfw' | 'faces' | 'finished';

export type ImageProcessing = {
  uuid: string;
  src: string;
  file: File;
  hash?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  nsfw?: boolean;
  blockedFor?: string[];
  needsReview?: boolean;
  status?: ImageProcessingStatus;
  mimeType?: string;
  sizeKB?: number;
};

export type StatusMessage = { uuid: string; status: ImageProcessingStatus };
export type ErrorMessage = { uuid: string; msg: string };
export type AnalysisMessage = {
  uuid: string;
  analysis: Record<string, unknown>;
};

export type ScanImageMessage =
  | { type: 'error'; payload: ErrorMessage }
  | { type: 'processing'; payload: ImageProcessing };

export type WorkerOutgoingMessage =
  | { type: 'ready' }
  | { type: 'error'; payload: ErrorMessage }
  | { type: 'nsfw'; payload: AnalysisMessage }
  | { type: 'faces'; payload: AnalysisMessage }
  | { type: 'status'; payload: StatusMessage }
  | { type: 'log'; payload: any };

export type AnalyzePayload = Array<{
  uuid: string;
  file: File;
  imageData: ImageData;
}>;
export type WorkerIncomingMessage = {
  type: 'analyze';
  payload: AnalyzePayload;
};

export type NSFW_TYPES = 'drawing' | 'hentai' | 'neutral' | 'porn' | 'sexy';
export type PredictionType = {
  className: NSFW_TYPES;
  probability: number;
};
