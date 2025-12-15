import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { WorkflowDefinition } from '~/server/services/orchestrator/types';
import { workflowDefinitionLabel } from '~/server/services/orchestrator/types';
import type { ComfyNode } from '~/shared/types/generation.types';
import { sortAlphabeticallyBy } from '~/utils/array-helpers';
import { parseAIR } from '~/utils/string-helpers';
import { workflowDefinitions } from '~/server/services/orchestrator/comfy/comfy.types';
import { uniqBy } from 'lodash-es';

export async function getWorkflowDefinitions() {
  // const workflowsJsons = await sysRedis.hGetAll(REDIS_SYS_KEYS.GENERATION.WORKFLOWS);
  // if (!workflowsJsons) throw new Error('No workflows found');
  // const uniqueWorkflows = uniqBy(
  //   [...Object.values(workflowsJsons).map((val) => JSON.parse(val)), ...workflowDefinitions],
  //   'key'
  // ) as WorkflowDefinition[];
  // const workflows = uniqueWorkflows.map((workflow) => ({
  //   ...workflow,
  //   label: `${workflowDefinitionLabel[workflow.type]} ${workflow.name}`.trim(),
  // }));
  const workflows = workflowDefinitions.map((workflow) => ({
    ...workflow,
    label: `${workflowDefinitionLabel[workflow.type]} ${workflow.name}`.trim(),
  }));

  return sortAlphabeticallyBy(workflows, (x) => x.label);
}

export async function clearWorkflowDefinitions() {
  const workflows = await getWorkflowDefinitions();
  await Promise.all(
    workflows.map((workflow) => sysRedis.hDel(REDIS_SYS_KEYS.GENERATION.WORKFLOWS, workflow.key))
  );
}

export async function getWorkflowDefinition(key: string) {
  // const workflowJson = await sysRedis.hGet(REDIS_SYS_KEYS.GENERATION.WORKFLOWS, key);
  // const workflow = workflowJson
  //   ? (JSON.parse(workflowJson) as WorkflowDefinition)
  //   : workflowDefinitions.find((x) => x.key === key);
  const workflow = workflowDefinitions.find((x) => x.key === key);
  if (!workflow) throw new Error('Workflow not found');
  return workflow;
}

export async function setWorkflowDefinition(key: string, data: WorkflowDefinition) {
  await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.WORKFLOWS, key, JSON.stringify(data));
}

export async function populateWorkflowDefinition(key: string, data: any) {
  const { template } = await getWorkflowDefinition(key);
  const populated = template
    .replace(/"\{\{\{(\w+)\}\}\}"/g, '{{$1}}')
    .replace(/{\s*{\s*([\w]+)\s*}\s*}/g, (_: any, match: any) => {
      let toInject = data[match];
      if (typeof toInject === 'string') toInject = JSON.stringify(toInject).replace(/^"|"$/g, '');
      return toInject;
    });
  try {
    return JSON.parse(populated);
  } catch (e) {
    console.log('-------------------');
    console.log(e);
    console.log('-------------------');
    throw new Error('Failed to populate workflow');
  }
}

const CHECKPOINT_LOADERS = ['CheckpointLoaderSimple', 'CheckpointLoader'];
const UPSCALER_LOADERS = ['UpscaleModelLoader'];
const ADDITIONAL_LOADERS = ['LoraLoader'];
const LORA_TYPES = ['lora', 'dora', 'lycoris'];

export function applyResources(
  workflow: Record<string, ComfyNode>,
  resources: { air: string; triggerWord?: string; strength?: number }[]
) {
  // Add references to children
  const checkpointLoaders: ComfyNode[] = [];
  const upscalers: ComfyNode[] = [];
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      const refNode = workflow[value[0]];
      if (!refNode._children) refNode._children = [];
      refNode._children.push({ node, inputKey: key });
    }

    if (UPSCALER_LOADERS.includes(node.class_type)) upscalers.push(node);
    if (CHECKPOINT_LOADERS.includes(node.class_type)) checkpointLoaders.push(node);
  }

  // Add resource nodes
  const needsResources = checkpointLoaders.length;
  let i = 0;
  const stackKeys = [`resource-stack`];
  for (const resource of resources) {
    const parsedAir = parseAIR(resource.air);
    if (parsedAir.type === 'checkpoint' && needsResources) {
      workflow[stackKeys[0]] = {
        inputs: {
          ckpt_name: resource.air,
        },
        class_type: 'CheckpointLoaderSimple',
      };
      continue;
    }

    if (parsedAir.type === 'vae') {
      workflow['vae'] = {
        inputs: {
          vae_name: resource.air,
        },
        class_type: 'VAELoader',
      };
    }

    let node: ComfyNode | undefined;
    if (LORA_TYPES.includes(parsedAir.type)) {
      node = {
        inputs: {
          lora_name: resource.air,
          strength_model: resource.strength ?? 1,
          strength_clip: 1,
          model: [stackKeys[i], 0],
          clip: [stackKeys[i], 1],
        },
        class_type: 'LoraLoader',
      };
    }

    // If it's an embedding, replace trigger word with embedding reference
    if (parsedAir.type === 'embedding' && resource.triggerWord) {
      for (const node of Object.values(workflow)) {
        for (const [key, value] of Object.entries(node.inputs)) {
          if (typeof value === 'string' && value.includes(resource.triggerWord)) {
            const negRegex = new RegExp(`\\b${resource.triggerWord}-neg\\b`, 'gi');
            const regex = new RegExp(`\\b${resource.triggerWord}\\b`, 'gi');
            node.inputs[key] = value
              .replace(negRegex, '')
              .replace(regex, `embedding:${resource.air}`);
          }
        }
      }
    }

    if (node && needsResources) {
      // increment stack key
      const stackKey = `${stackKeys[0]}-${++i}`;
      stackKeys.push(stackKey);
      workflow[stackKey] = node;
    }
  }

  // Update reference to point to resource nodes
  const toRemove = new Set<ComfyNode>();
  for (const checkpointLoader of checkpointLoaders) {
    toRemove.add(checkpointLoader);
    const children = (checkpointLoader._children ?? []).map(({ node, inputKey }) => ({
      child: node,
      parent: checkpointLoader,
      inputKey,
    }));

    // follow children until we reach something other than a loader
    while (children.length) {
      const { child, parent, inputKey } = children.shift()!;
      if (ADDITIONAL_LOADERS.includes(child.class_type)) {
        toRemove.add(child);
        // if it's a loader, add its children
        children.push(
          ...(child._children ?? []).map(({ node, inputKey }) => ({
            child: node,
            parent: child,
            inputKey,
          }))
        );
      } else {
        const value = child.inputs[inputKey];
        if (Array.isArray(value)) {
          // Disabled since this approach requires every workflow to also include a LoraLoader
          // if (CHECKPOINT_LOADERS.includes(parent.class_type)) {
          //   // If it's not a loader, and it references the checkpoint, reference head node
          //   value[0] = stackKeys[0];
          // } else {
          //   // If it's not a loader, and it doesn't reference the checkpoint, reference tail node
          //   value[0] = stackKeys[stackKeys.length - 1];
          // }

          if (inputKey === 'vae') {
            // We only need to reference the checkpoint for the vae
            if (workflow['vae']) {
              value[0] = 'vae';
              value[1] = 0;
            } else {
              value[0] = stackKeys[0];
            }
          } else {
            // otherwise, reference tail node
            value[0] = stackKeys[stackKeys.length - 1];
          }
        }
      }
    }
  }

  // Clean up the workflow
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (toRemove.has(node)) delete workflow[nodeId];
    delete node._children;
  }
}
