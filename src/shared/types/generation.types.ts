type NodeRef = [string, number];
export type ComfyNode = {
  inputs: Record<string, number | string | NodeRef>;
  class_type: string;
  _meta?: Record<string, string>;
  _children?: { node: ComfyNode; inputKey: string }[];
};

interface BaseGenerationWorkflowConfig {
  id: number;
  name: string; // ie. Face fix
  description?: string;
  batchSize?: number;
}

interface ImageGenerationWorkflowConfig {
  type: 'image';
  subType: 'txt2img' | 'img2img';
}

interface VideoGenerationWorkflowConfig {
  type: 'video';
  subType: 'txt2vid' | 'img2vid';
}

interface ModelGenerationWorkflowConfig {
  category: 'model';
  modelId?: number;
  env?: string; // ie. sd1, sdxl, flux, sd3
}

interface ServiceGenerationWorkflowConfig {
  category: 'service';
  engine: string;
}

export type GenerationWorkflowConfig = BaseGenerationWorkflowConfig &
  (ImageGenerationWorkflowConfig | VideoGenerationWorkflowConfig) &
  (ModelGenerationWorkflowConfig | ServiceGenerationWorkflowConfig);
