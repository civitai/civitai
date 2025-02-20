import { z } from 'zod';
import { OrchestratorEngine } from '~/server/orchestrator/infrastructure/base.enums';

type NodeRef = [string, number];
export type ComfyNode = {
  inputs: Record<string, number | string | NodeRef>;
  class_type: string;
  _meta?: Record<string, string>;
  _children?: { node: ComfyNode; inputKey: string }[];
};

export interface GenerationEngine {
  engine: OrchestratorEngine;
  disabled?: boolean;
  message?: string;
}
