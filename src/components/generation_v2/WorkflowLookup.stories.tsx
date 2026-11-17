import { StoryTRPCProvider } from '../../../.ladle/trpc';
import { WorkflowLookup } from '~/components/generation_v2/WorkflowLookup';

// Click the search icon, enter any ID and press Lookup.
const workflow = {
  status: 'succeeded',
  createdAt: new Date('2026-10-29T06:16:02Z'),
  metadata: {
    params: {
      workflow: 'txt2img',
      prompt: 'a lighthouse on a cliff at dusk, volumetric fog, cinematic lighting',
    },
    resources: [],
  },
};

export const Default = () => (
  <StoryTRPCProvider mocks={{ 'orchestrator.getWorkflowForModeration': workflow }}>
    <div style={{ height: 260 }}>
      <WorkflowLookup />
    </div>
  </StoryTRPCProvider>
);

export const NotFound = () => (
  <StoryTRPCProvider
    mocks={{
      'orchestrator.getWorkflowForModeration': () => {
        throw new Error('Workflow not found');
      },
    }}
  >
    <div style={{ height: 160 }}>
      <WorkflowLookup />
    </div>
  </StoryTRPCProvider>
);
