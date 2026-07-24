import { config } from '../config';
import {
  SpineWorkflowRequest,
  SpineWorkflowAPIRequest,
  WorkflowStep,
  StepBuilder,
  KafkaWorkflowConfig,
} from '../types/spine';

/**
 * Spine Orchestrator Service
 * Handles workflow submission to the Spine orchestration system
 */
export class SpineService {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl ?? config.spine.url;
    this.apiKey = apiKey ?? config.spine.apiKey;
  }

  /**
   * Submit a workflow request to Spine
   */
  async submitWorkflow(request: SpineWorkflowRequest): Promise<void> {
    const apiRequest = this.transformRequest(request);

    const response = await fetch(`${this.baseUrl}/v2/consumer/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(apiRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Spine workflow submission failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }
  }

  /**
   * Transform a SpineWorkflowRequest to the API format
   * Handles conversion of function-based steps to raw $ref format
   */
  private transformRequest(request: SpineWorkflowRequest): SpineWorkflowAPIRequest {
    // If steps is already an array, return as-is
    if (Array.isArray(request.steps)) {
      return request as SpineWorkflowAPIRequest;
    }

    // Steps is a function - transform it
    const steps = this.transformSteps(request.steps, request.arguments ?? {});

    return {
      ...request,
      steps,
    };
  }

  /**
   * Transform function-based steps to raw API format
   * Uses Proxy to track property access and convert to $ref objects
   */
  private transformSteps(
    stepBuilder: StepBuilder,
    requestArguments: Record<string, any>
  ): WorkflowStep[] {
    // Track property accesses
    const propertyAccesses = new Map<any, { type: 'args' | 'output'; path: string[] }>();

    // Create proxy for args
    const argsProxy = this.createTrackingProxy([], 'args', propertyAccesses);

    // Create proxy for output
    const outputProxy = this.createTrackingProxy([], 'output', propertyAccesses);

    // Execute the step builder to get steps with tracked proxies
    const steps = stepBuilder({
      args: argsProxy,
      output: outputProxy,
    });

    // Build map of step IDs to array indices
    const idToIndex = new Map<string, number>();
    steps.forEach((step, index) => {
      if (step.name) {
        idToIndex.set(step.name, index);
      }
    });

    // Transform steps by replacing tracked proxies with $ref objects
    const transformedSteps = steps.map((step, stepIndex) => {
      const transformedStep: WorkflowStep = {
        $type: step.$type,
        ...(step.metadata && { metadata: step.metadata }),
      };

      // Transform input by replacing proxies with $ref objects
      if (step.input) {
        transformedStep.input = this.transformObject(
          step.input,
          propertyAccesses,
          idToIndex
        );
      }

      // Remove name from final output (only used for transformation)
      return transformedStep;
    });

    return transformedSteps;
  }

  /**
   * Create a proxy that tracks property access paths
   */
  private createTrackingProxy(
    path: string[],
    type: 'args' | 'output',
    accesses: Map<any, { type: 'args' | 'output'; path: string[] }>
  ): any {
    const proxy = new Proxy(
      {},
      {
        get: (target, prop) => {
          if (typeof prop === 'symbol') return undefined;

          const newPath = [...path, prop];
          const childProxy = this.createTrackingProxy(newPath, type, accesses);
          accesses.set(childProxy, { type, path: newPath });
          return childProxy;
        },
      }
    );

    accesses.set(proxy, { type, path });
    return proxy;
  }

  /**
   * Recursively transform an object, replacing tracked proxies with $ref objects
   */
  private transformObject(
    obj: any,
    accesses: Map<any, { type: 'args' | 'output'; path: string[] }>,
    idToIndex: Map<string, number>
  ): any {
    // Check if this object is a tracked proxy
    const access = accesses.get(obj);
    if (access) {
      return this.createRefObject(access, idToIndex);
    }

    // If it's a primitive, return as-is
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    // If it's an array, transform each element
    if (Array.isArray(obj)) {
      return obj.map((item) => this.transformObject(item, accesses, idToIndex));
    }

    // If it's an object, transform each property
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      transformed[key] = this.transformObject(value, accesses, idToIndex);
    }
    return transformed;
  }

  /**
   * Create a $ref object from a tracked property access
   */
  private createRefObject(
    access: { type: 'args' | 'output'; path: string[] },
    idToIndex: Map<string, number>
  ): { $ref: string; path: string } {
    if (access.type === 'args') {
      // args.mediaUrl -> { $ref: '$arguments', path: 'mediaUrl' }
      return {
        $ref: '$arguments',
        path: access.path.join('.'),
      };
    }

    // output.tagging.blob.url or output.$0.blob.url
    const [firstSegment, ...rest] = access.path;

    // Check if first segment is a step ID
    if (idToIndex.has(firstSegment)) {
      const index = idToIndex.get(firstSegment)!;
      return {
        $ref: `$${index}`,
        path: rest.length > 0 ? rest.join('.') : '',
      };
    }

    // Check if first segment is numeric index like $0, $1
    if (firstSegment.startsWith('$')) {
      return {
        $ref: firstSegment,
        path: rest.length > 0 ? rest.join('.') : '',
      };
    }

    // Assume it's a step ID that wasn't found - use as-is
    // This might need to be an error in production
    return {
      $ref: `$${firstSegment}`,
      path: rest.length > 0 ? rest.join('.') : '',
    };
  }
}

// Export singleton instance
export const spineService = new SpineService();

/**
 * Helper to create Kafka-based workflow requests
 * Automatically adds tags, callback URL, and output parameter based on step.output flags
 */
export function withKafka(workflowConfig: KafkaWorkflowConfig): SpineWorkflowRequest {
  const { topic, metadata, arguments: args, steps, callbackUrl } = workflowConfig;

  // Normalize steps to array (execute builder if needed)
  let stepsArray: WorkflowStep[];
  if (typeof steps === 'function') {
    // Create dummy context to get steps
    const dummyArgs = new Proxy({}, { get: () => undefined });
    const dummyOutput = new Proxy({}, { get: () => undefined });
    stepsArray = steps({ args: dummyArgs, output: dummyOutput });
  } else {
    stepsArray = steps;
  }

  // Find indices of steps with output: true (default to true if not specified)
  const outputIndices = stepsArray
    .map((step, index) => (step.output !== false ? index : -1))
    .filter((index) => index !== -1);

  // Build callback URL with topic and outputs query params
  const baseUrl = callbackUrl ?? config.spine.kafkaCallbackUrl;
  const outputsParam = outputIndices.join(',');
  const url = `${baseUrl}?topic=${encodeURIComponent(topic)}${outputsParam ? `&outputs=${outputsParam}` : ''}`;

  return {
    metadata,
    arguments: args,
    tags: ['kafka', `kafka:${topic}`],
    steps, // Return original steps (array or function) for transformation
    callbacks: [
      {
        url,
        type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
        detailed: true,
      },
    ],
  };
}
