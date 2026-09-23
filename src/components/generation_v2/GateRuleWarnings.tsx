import { MultiController, useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';

import { GateRuleAlerts } from './Experimental';
import { GeneratorMessageAlerts } from './GeneratorMessages';

const SELECTION = ['ecosystem', 'workflow', 'model', 'resources', 'vae'] as const;

export function GateRuleWarnings() {
  const graph = useGraph<GenerationGraphTypes>();

  return (
    <MultiController
      graph={graph}
      names={SELECTION}
      render={({ values }) => <GateRuleAlerts selection={values} />}
    />
  );
}

export function GeneratorMessageWarnings() {
  const graph = useGraph<GenerationGraphTypes>();

  return (
    <MultiController
      graph={graph}
      names={SELECTION}
      render={({ values }) => <GeneratorMessageAlerts selection={values} />}
    />
  );
}
