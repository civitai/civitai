import { Button, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useSyncExternalStore } from 'react';
import { avatarDisplay } from '~/components/AvatarGen/avatar-display';
import { AvatarProfilePictureButton } from '~/components/AvatarGen/AvatarProfilePictureButton';
import { AVATAR_WORKFLOW } from '~/shared/constants/avatar-styles.constants';
import type { BlobData, WorkflowData } from '~/shared/orchestrator/workflow-data';
import { useActiveGenerationForm } from '~/store/active-generation-form.store';
import { generationGraphPanel } from '~/store/generation-graph.store';

/** What produced a generation, shown above its outputs. */
export type GenerationSummary = { image?: string; rows: { label: string; value: string }[] };

export type OutputAction =
  /** Opens this workflow's form with fields taken from the output, e.g. to refine it. */
  | {
      kind: 'fillForm';
      label: string;
      activeLabel: string;
      fields: (output: BlobData, workflow: WorkflowData) => Record<string, unknown>;
    }
  | { kind: 'profilePicture' };

/** How a workflow's generations differ in the queue card. */
export type WorkflowDisplay = {
  summary?: (workflow: WorkflowData) => GenerationSummary | undefined;
  /** Buttons under each finished image. */
  outputActions?: readonly OutputAction[];
};

export const workflowDisplays: Partial<Record<string, WorkflowDisplay>> = {
  [AVATAR_WORKFLOW]: avatarDisplay,
};

export function GenerationSummaryStrip({ summary }: { summary: GenerationSummary }) {
  return (
    <div className="flex items-center gap-3">
      {summary.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={summary.image} alt="" className="size-14 shrink-0 rounded object-cover" />
      )}
      <div className="min-w-0">
        {summary.rows.map((row) => (
          <Text key={row.label} size="xs">
            <span className="text-gray-6 dark:text-dark-2">{row.label}:</span> {row.value}
          </Text>
        ))}
      </div>
    </div>
  );
}

export function OutputActions({
  output,
  actions,
}: {
  output: BlobData;
  actions: readonly OutputAction[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {actions.map((action) =>
        action.kind === 'fillForm' ? (
          <FillFormButton key={action.label} action={action} output={output} />
        ) : (
          <AvatarProfilePictureButton key={action.kind} output={output} />
        )
      )}
    </div>
  );
}

function FillFormButton({
  action,
  output,
}: {
  action: Extract<OutputAction, { kind: 'fillForm' }>;
  output: BlobData;
}) {
  const form = useActiveGenerationForm((state) => state.store);
  const fields = action.fields(output, output.workflow);
  const workflow = output.workflow.params.workflow;
  // Filled when the form already holds this output's fields.
  const active = useSyncExternalStore(
    (onChange) => form?.subscribe(onChange) ?? (() => undefined),
    () => {
      const state = form?.getSnapshot().state as Record<string, unknown> | undefined;
      return (
        !!state &&
        state.workflow === workflow &&
        Object.entries(fields).every(([key, value]) => state[key] === value)
      );
    },
    () => false
  );

  return (
    <Button
      size="compact-sm"
      className="flex-1"
      variant={active ? 'filled' : 'light'}
      leftSection={<IconSparkles size={14} />}
      onClick={() => {
        // The workflow first, so its fields exist to receive the values.
        form?.set({ workflow });
        form?.set(fields);
        generationGraphPanel.setView('generate');
      }}
    >
      {active ? action.activeLabel : action.label}
    </Button>
  );
}
