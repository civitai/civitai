import { trpc } from '~/utils/trpc';

export function useWorkflowDefinitions(type: 'image' | 'video') {
  const { data } = trpc.workflowDefinition.getWorkflowDefinitions.useQuery();
  return data.filter((x) => x.type === type);
}
