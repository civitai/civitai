// Spine Orchestrator Types

export type WorkflowCallbackType =
  | 'workflow:*'
  | 'workflow:unassigned'
  | 'workflow:processing'
  | 'workflow:succeeded'
  | 'workflow:failed'
  | 'workflow:expired'
  | 'workflow:canceled'
  | 'step:*'
  | 'step:unassigned'
  | 'step:processing'
  | 'step:succeeded'
  | 'step:failed'
  | 'step:expired'
  | 'step:canceled';

export interface WorkflowCallback {
  url: string;
  type: WorkflowCallbackType[];
  detailed?: boolean;
}

export interface WorkflowStep {
  $type: string;
  name?: string; // Optional ID for referencing in ergonomic API
  metadata?: Record<string, any>;
  input?: Record<string, any>;
  output?: boolean; // Whether to include this step's output in Kafka callback
}

export type StepBuilder = (context: {
  args: Record<string, any>;
  output: Record<string, any>;
}) => WorkflowStep[];

export interface SpineWorkflowRequest {
  metadata?: Record<string, any>;
  arguments?: Record<string, any>;
  tags?: string[];
  steps: WorkflowStep[] | StepBuilder;
  callbacks?: WorkflowCallback[];
}

// Internal type used for API submission (after transformation)
export interface SpineWorkflowAPIRequest {
  metadata?: Record<string, any>;
  arguments?: Record<string, any>;
  tags?: string[];
  steps: WorkflowStep[];
  callbacks?: WorkflowCallback[];
}

// Helper type for Kafka-based workflows
export interface KafkaWorkflowConfig {
  topic: string;
  metadata?: Record<string, any>;
  arguments?: Record<string, any>;
  steps: WorkflowStep[] | StepBuilder;
  callbackUrl?: string; // Default: https://orchestrator-kafka.civitai.com/callback
}
