import { MultiController } from 'form-graph/react';

import { GateRuleAlerts } from '~/components/generation_v2/Experimental';
import { GeneratorMessageAlerts } from '~/components/generation_v2/GeneratorMessages';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';

const SELECTION = ['ecosystem', 'workflow', 'model', 'resources', 'vae'] as const;

export function GateRuleWarnings() {
  return (
    <MultiController
      graph={generationHub}
      names={SELECTION}
      render={({ values }) => <GateRuleAlerts selection={values} />}
    />
  );
}

export function GeneratorMessageWarnings() {
  return (
    <MultiController
      graph={generationHub}
      names={SELECTION}
      render={({ values }) => <GeneratorMessageAlerts selection={values} />}
    />
  );
}
