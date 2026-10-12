import type {
  AceStepAudioStepTemplate,
  ChatCompletionStepTemplate,
  MiniMaxMusic3StepTemplate,
  ComfyStepTemplate,
  ImageGenStepTemplate,
  PreprocessImageStepTemplate,
  PromptEnhancementStepTemplate,
  VideoGenStepTemplate,
  VideoInterpolationStepTemplate,
} from '@civitai/client';
import type {
  ImageGenStepTemplate as OrchestrationImageGenStepTemplate,
  PreprocessVideoStepTemplate,
  SoniloAudioGenStepTemplate,
  YuE2StepTemplate,
} from '@civitai/orchestration-client';

export type StepInput =
  | ComfyStepTemplate
  | ImageGenStepTemplate
  | VideoGenStepTemplate
  | VideoInterpolationStepTemplate
  | AceStepAudioStepTemplate
  | MiniMaxMusic3StepTemplate
  | YuE2StepTemplate
  | SoniloAudioGenStepTemplate
  | ChatCompletionStepTemplate
  | PromptEnhancementStepTemplate
  | PreprocessImageStepTemplate
  // Sourced from @civitai/orchestration-client: the pinned @civitai/client
  // predates preprocessVideo and has no equivalent type.
  | PreprocessVideoStepTemplate
  // Ming and Qwen build theirs from orchestration-client, whose Priority adds 'idle'
  | OrchestrationImageGenStepTemplate;

export type { GenerationHandlerCtx } from '../orchestration-new.service';
export { defineHandler } from './handler-factory';
