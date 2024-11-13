type NodeRef = [string, number];
export type ComfyNode = {
  inputs: Record<string, number | string | NodeRef>;
  class_type: string;
  _meta?: Record<string, string>;
  _children?: { node: ComfyNode; inputKey: string }[];
};

// #region [workflow config]
interface BaseGenerationWorkflowConfig {
  // id: number;
  key: string; // in place of id for uniqueness
  name: string; // ie. Face fix
  description?: string;
  /** used for things like 'draft mode' */ // TODO - determine if this should simply go into `values` prop
  batchSize?: number;
  /** displays an alert message about the generation workflow  */
  message?: string;
  /** default values used for generation */
  defaultValues?: Record<string, any>;
  metadataDisplayProps?: string[];
}

interface ImageGenerationWorkflowConfig {
  type: 'image';
  subType: 'txt2img' | 'img2img';
}

interface VideoGenerationWorkflowConfig {
  type: 'video';
  subType: 'txt2vid' | 'img2vid';
}

interface AudioGenerationWorkflowConfig {
  type: 'audio';
  subType: 'txt2aud';
}

export type GenerationWorkflowTypeConfig =
  | ImageGenerationWorkflowConfig
  | VideoGenerationWorkflowConfig
  | AudioGenerationWorkflowConfig;

interface ModelGenerationWorkflowConfig {
  category: 'model';
  modelId?: number;
  env: string | string[]; // ie. sd1, sdxl, flux, sd3
  modelType?: string | string[];
  checkpointSelect?: boolean; // not sure about this one
  additionalResources?: boolean;
}

interface ServiceGenerationWorkflowConfig {
  category: 'service';
  engine: string;
}

export type GenerationWorkflowCategoryConfig =
  | ModelGenerationWorkflowConfig
  | ServiceGenerationWorkflowConfig;

export type GenerationWorkflowConfig = BaseGenerationWorkflowConfig &
  GenerationWorkflowTypeConfig &
  GenerationWorkflowCategoryConfig;

// #endregion
