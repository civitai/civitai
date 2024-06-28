import { ComfyNode } from '~/shared/types/generation.types';
import { parseAIR } from '~/utils/string-helpers';

const CHECKPOINT_LOADERS = ['CheckpointLoaderSimple', 'CheckpointLoader'];
const ADDITIONAL_LOADERS = ['LoraLoader'];

export function applyResources(
  workflow: Record<string, ComfyNode>,
  resources: { air: string; strength?: number }[]
) {
  // Add references to children
  const checkpointLoaders: ComfyNode[] = [];
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      const refNode = workflow[value[0]];
      if (!refNode._children) refNode._children = [];
      refNode._children.push({ node, inputKey: key });
    }

    if (CHECKPOINT_LOADERS.includes(node.class_type)) checkpointLoaders.push(node);
  }

  // Add resource nodes
  let i = 0;
  const stackKeys = [`resource-stack`];
  for (const resource of resources) {
    const parsedAir = parseAIR(resource.air);
    if (parsedAir.type === 'checkpoint') {
      workflow[stackKeys[0]] = {
        inputs: {
          ckpt_name: resource.air,
        },
        class_type: 'CheckpointLoaderSimple',
      };
      continue;
    }

    let node: ComfyNode | undefined;
    if (parsedAir.type === 'lora') {
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
    // TODO add embedding node

    if (node) {
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
          if (CHECKPOINT_LOADERS.includes(parent.class_type)) {
            // If it's not a loader, and it references the checkpoint, reference head node
            value[0] = stackKeys[0];
          } else {
            // If it's not a loader, and it doesn't reference the checkpoint, reference tail node
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
