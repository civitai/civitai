import type { ReactNode } from 'react';
import { WorkflowPicker } from '~/components/generation_v2/inputs/WorkflowPicker';
import { ChoiceGroup } from '~/libs/form/components/ChoiceGroup';
import type { ChoiceOption } from '~/libs/form/components/ChoiceGroup';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';
import { RenderGenerationSetupModel } from '~/components/generation_v2/GenerationLayout';
import classes from './WorkflowRow.module.scss';

/**
 * The form's top: two cards. The workflow with its modes, then the model card, headed by the
 * ecosystem that decides it, holding the form's model and versions from `GenerationSetupModel`.
 */
export function WorkflowRow({
  workflow,
  ecosystemId,
  onBack,
  onChange,
  isCompatible,
  isMember,
  ecosystemInput,
  modes,
}: {
  workflow: string;
  ecosystemId?: number;
  onBack?: () => void;
  onChange: (graphKey: string) => void;
  isCompatible?: (optionId: string) => boolean;
  isMember?: boolean;
  ecosystemInput: ReactNode;
  modes: ChoiceOption[];
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className={classes.setupCard}>
        <WorkflowPicker
          value={workflow}
          ecosystemId={ecosystemId}
          onChange={(graphKey) => onChange(graphKey)}
          isCompatible={isCompatible}
          isMember={isMember}
          onBack={onBack}
        />
        {modes.length > 0 && (
          <ChoiceGroup
            className={classes.modes}
            aria-label="Mode"
            value={workflowConfigByKey.get(workflow)?.variantOf ?? workflow}
            onChange={onChange}
            data={modes}
          />
        )}
      </div>
      <div className={classes.setupCard}>
        {ecosystemInput}
        <RenderGenerationSetupModel className={classes.model} />
      </div>
    </div>
  );
}
