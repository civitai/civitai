/**
 * Prompt Enhancement Hooks
 *
 * Submission, history query, and record mapping for prompt enhancement workflows.
 * State is derived from workflow status in the cache — no separate Zustand store.
 * Signal handling is built into the history query hook.
 */

import type {
  PromptEnhancementInput,
  PromptEnhancementOutput,
  PromptEnhancementStep,
} from '@civitai/client';
import { useEffect, useMemo, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { trpc, trpcVanilla } from '~/utils/trpc';
import {
  type WorkflowItem,
  addWorkflowToTagCache,
  updateWorkflowInTagCache,
  fetchWorkflowById,
  onWorkflowSignal,
} from '~/components/Orchestrator/workflowHooks';

// =============================================================================
// Constants
// =============================================================================

const PROMPT_ENHANCEMENT_TAGS = ['prompt-enhancement'];

// =============================================================================
// Types
// =============================================================================

export type PromptEnhancementRecord = {
  workflowId: string;
  createdAt: string;
  ecosystem: string;
  originalPrompt: string;
  originalNegativePrompt?: string;
  enhancedPrompt?: string;
  enhancedNegativePrompt?: string;
  issues?: PromptEnhancementOutput['issues'];
  recommendations?: PromptEnhancementOutput['recommendations'];
  instruction?: string;
  preserveTriggerWords?: string[];
  temperature?: number;
  status: string;
};

// =============================================================================
// Workflow → Record mapping
// =============================================================================

function mapWorkflowToRecord(workflow: WorkflowItem): PromptEnhancementRecord | null {
  const step = workflow.steps?.find(
    (s) => s.$type === 'promptEnhancement' || s.name === 'prompt-enhancement'
  ) as PromptEnhancementStep | undefined;
  if (!step?.input) return null;

  const input = step.input as PromptEnhancementInput | undefined;
  const output = step.output as PromptEnhancementOutput | undefined;
  const meta = workflow.metadata ?? {};

  return {
    workflowId: workflow.id,
    createdAt: workflow.createdAt,
    ecosystem: input?.ecosystem ?? '',
    originalPrompt: input?.prompt ?? '',
    originalNegativePrompt: input?.negativePrompt ?? undefined,
    enhancedPrompt: output?.enhancedPrompt,
    enhancedNegativePrompt: output?.enhancedNegativePrompt ?? undefined,
    issues: output?.issues,
    recommendations: output?.recommendations,
    instruction: (meta.userInstruction as string) ?? undefined,
    preserveTriggerWords: (meta.preserveTriggerWords as string[]) ?? undefined,
    temperature: input?.temperature ?? undefined,
    status: workflow.status,
  };
}

// =============================================================================
// History query (with signal handling)
// =============================================================================

export function useGetPromptEnhancementHistory() {
  const currentUser = useCurrentUser();

  const { data, ...rest } = trpc.orchestrator.queryWorkflowsByTags.useInfiniteQuery(
    { tags: PROMPT_ENHANCEMENT_TAGS },
    {
      getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
      enabled: !!currentUser,
    }
  );

  // Register signal listener — when a workflow in our cache completes, fetch and update
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    return onWorkflowSignal(async (event) => {
      const allItems = dataRef.current?.pages?.flatMap((page) => page.items ?? []) ?? [];
      const match = allItems.find((item) => item.id === event.workflowId);
      if (!match) return;

      try {
        const workflowItem = await fetchWorkflowById(event.workflowId);
        updateWorkflowInTagCache(workflowItem, PROMPT_ENHANCEMENT_TAGS);
      } catch {
        // Signal fetch failed — will be picked up on next query
      }
    });
  }, []);

  const records = useMemo(() => {
    if (!data?.pages) return [];
    const items = data.pages.flatMap((page) => page.items ?? []);
    return items
      .map((workflow) => mapWorkflowToRecord(workflow as unknown as WorkflowItem))
      .filter((r): r is PromptEnhancementRecord => r !== null);
  }, [data]);

  return { data: records, ...rest };
}

// =============================================================================
// Submit enhancement
// =============================================================================

/**
 * Submit a prompt enhancement request.
 * Returns the workflow ID. The result will appear in the history query
 * when the workflow completes (via signal or polling).
 */
export async function submitPromptEnhancement(input: PromptEnhancementSchema): Promise<string> {
  const workflow = await trpcVanilla.orchestrator.enhancePrompt.mutate(input);
  const workflowItem = workflow as unknown as WorkflowItem;

  // Add to history cache immediately (shows as in-progress)
  addWorkflowToTagCache(workflowItem, PROMPT_ENHANCEMENT_TAGS);

  return workflowItem.id;
}
