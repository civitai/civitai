export interface SourceImage {
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface IterationEntry {
  id: string;
  prompt: string;
  annotated: boolean;
  sourceImage: SourceImage | null;
  /** The selected/current result image */
  resultImage: SourceImage | null;
  /** All generated images (when quantity > 1) */
  resultImages: SourceImage[];
  cost: number;
  timestamp: Date;
  status: 'generating' | 'ready' | 'error';
  errorMessage?: string;
}

export interface IterativeEditorConfig {
  modelOptions: { value: string; label: string }[];
  modelSizes: Record<string, { label: string; width: number; height: number }[]>;
  modelMaxImages: Record<string, number>;
  defaultModel: string;
  defaultAspectRatio: string;
  /** Fallback cost if whatIf query is unavailable */
  generationCost: number;
  /** Fallback enhance cost if whatIf query is unavailable */
  enhanceCost: number;
  commitLabel?: string;
}

export interface CostEstimate {
  cost: number;
  ready: boolean;
}

export interface CostEstimateParams {
  baseModel: string | null;
  aspectRatio: string;
  quantity: number;
  hasSourceImage: boolean;
}

export interface GenerateParams {
  prompt: string;
  enhance: boolean;
  aspectRatio: string;
  baseModel: string | null;
  quantity: number;
  sourceImageUrl?: string;
  sourceImageWidth?: number;
  sourceImageHeight?: number;
  selectedImageIds?: number[];
}

export interface PollParams {
  workflowId: string;
  width?: number;
  height?: number;
  prompt?: string;
}

export interface GenerateResult {
  workflowId: string;
  width: number;
  height: number;
  cost?: number;
}

export interface PollResult {
  status: 'succeeded' | 'failed' | 'processing';
  imageUrl: string | null;
  imageId?: number;
  /** Multiple images when quantity > 1 */
  images?: { url: string; id?: number }[];
}

/** Context exposed to render props so plugins can read/write editor state */
export interface EditorSlotContext {
  prompt: string;
  setPrompt: (value: string) => void;
  isGenerating: boolean;
  selectedImageIds: number[] | null;
  setSelectedImageIds: (ids: number[] | null) => void;
  effectiveModel: string;
  maxReferenceImages: number;
}

export interface InputSlotProps extends EditorSlotContext {
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export interface SidebarSlotProps extends EditorSlotContext {}
