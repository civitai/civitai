import clsx from 'clsx';
import type { ReactNode } from 'react';
import {
  SelectedWorkflowDisplay,
  WorkflowInput,
  WorkflowPicker,
} from '~/components/generation_v2/inputs/WorkflowInput';
import type { ButtonGroupOption } from '~/libs/form/components/ButtonGroupInput';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';

/** These render their own workflow display, with their panels. */
const SELF_DISPLAYED = new Set(['img2meta', 'prompt:enhance']);

type WorkflowProps = {
  /** The mobile generator's layout. */
  mobile: boolean;
  workflow: string;
  ecosystemId?: number;
  onBack?: () => void;
};

/**
 * The form's top row: the workflow control and the ecosystem picker. On a phone the workflow is a
 * card above the ecosystem; elsewhere it is the category icons beside it.
 */
export function WorkflowRow({
  mobile,
  workflow,
  ecosystemId,
  onBack,
  onChange,
  isCompatible,
  isMember,
  ecosystemInput,
}: WorkflowProps & {
  onChange: (graphKey: string) => void;
  isCompatible?: (optionId: string) => boolean;
  isMember?: boolean;
  ecosystemInput: ReactNode;
}) {
  const common = {
    value: workflow,
    ecosystemId,
    onChange: (graphKey: string) => onChange(graphKey),
    isCompatible,
    isMember,
  };
  return (
    <div
      className={clsx(
        'flex w-full min-w-0 gap-2 sm:gap-4',
        mobile ? 'flex-col' : 'items-center overflow-hidden'
      )}
    >
      {!mobile ? (
        <WorkflowInput {...common} />
      ) : (
        !SELF_DISPLAYED.has(workflow) && <WorkflowPicker {...common} onBack={onBack} />
      )}
      {ecosystemInput}
    </div>
  );
}

/** Below the row: the selected workflow (desktop; on a phone the card shows it) and its modes. */
export function WorkflowModes({
  mobile,
  workflow,
  ecosystemId,
  onBack,
  modes,
  onChange,
}: WorkflowProps & {
  modes: ButtonGroupOption[];
  onChange: (workflow: string) => void;
}) {
  if (mobile && modes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {!mobile && (
        <SelectedWorkflowDisplay workflowId={workflow} ecosystemId={ecosystemId} onBack={onBack} />
      )}
      {modes.length > 0 && (
        <ButtonGroupInput
          value={workflowConfigByKey.get(workflow)?.variantOf ?? workflow}
          onChange={onChange}
          data={modes}
        />
      )}
    </div>
  );
}
