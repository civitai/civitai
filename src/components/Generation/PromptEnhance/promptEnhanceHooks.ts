import type {
  PromptEnhancementInput,
  PromptEnhancementOutput,
  PromptEnhancementStep,
} from '@civitai/client';
import type { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useMemo } from 'react';
import { create } from 'zustand';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { queryClient, trpc, trpcVanilla } from '~/utils/trpc';

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
  /** The user's custom instruction (without trigger word preservation text) */
  instruction?: string;
  /** Trigger words that were preserved during this enhancement */
  preserveTriggerWords?: string[];
  temperature?: number;
  status: string;
};

type WorkflowItem = {
  id: string;
  createdAt: string;
  status: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  steps: Array<{
    name: string;
    $type?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
};

type PromptEnhancementPage = {
  nextCursor: string | undefined;
  items: WorkflowItem[];
};

function mapWorkflowToRecord(workflow: WorkflowItem): PromptEnhancementRecord | null {
  // Try $type first, fall back to step name for robustness
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
// History query
// =============================================================================

export function useGetPromptEnhancementHistory() {
  const currentUser = useCurrentUser();

  const { data, ...rest } = trpc.orchestrator.queryPromptEnhancements.useInfiniteQuery(
    { tags: [] },
    {
      getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
      enabled: !!currentUser,
    }
  );

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
// Enhancement mutation (component-independent)
// =============================================================================

type EnhanceState = {
  isLoading: boolean;
  result: PromptEnhancementOutput | null;
  error: string | null;
};

const useEnhanceState = create<EnhanceState>()(() => ({
  isLoading: false,
  result: null,
  error: null,
}));

function addEnhancementToCache(workflow: WorkflowItem) {
  const queryKey = getQueryKey(trpc.orchestrator.queryPromptEnhancements);
  queryClient.setQueriesData(
    { queryKey, exact: false },
    (state: InfiniteData<PromptEnhancementPage> | undefined) =>
      produce(state, (old) => {
        if (!old?.pages?.[0]) return;
        old.pages[0].items.unshift(workflow);
      })
  );
}

export async function submitPromptEnhancement(input: PromptEnhancementSchema) {
  useEnhanceState.setState({ isLoading: true, result: null, error: null });

  try {
    const data = await trpcVanilla.orchestrator.enhancePrompt.mutate(input);

    if (data.output && data.workflowId) {
      addEnhancementToCache({
        id: data.workflowId,
        createdAt: new Date().toISOString(),
        status: 'succeeded',
        tags: ['civitai', 'prompt-enhancement'],
        metadata: {
          userInstruction: input.instruction || undefined,
          preserveTriggerWords: input.preserveTriggerWords || undefined,
        },
        steps: [
          {
            name: 'prompt-enhancement',
            $type: 'promptEnhancement',
            input: {
              ecosystem: input.ecosystem,
              prompt: input.prompt,
              negativePrompt: input.negativePrompt || undefined,
              temperature: input.temperature || undefined,
            },
            output: data.output,
          },
        ],
      });
    }

    useEnhanceState.setState({ isLoading: false, result: data.output ?? null });
    return data;
  } catch (error: any) {
    const message = error?.message ?? 'An unexpected error occurred';
    useEnhanceState.setState({ isLoading: false, error: message });
    throw error;
  }
}

/** Hook to read the current enhancement state (loading, result, error) */
export function useEnhancePromptState() {
  return useEnhanceState();
}
