import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The two generation lanes render from separate entry components, so anything
 * mounted in one and not the other is invisible until someone switches lanes.
 * The 2026-09-23 sweep (docs/form-graph-lane-parity-sweep.md) found the
 * content-generation tour and three alerts in exactly that state.
 *
 * These read source text because rendering either lane needs the whole provider
 * stack, and the defect is "the call site is absent" — which source can answer.
 */

const COMPONENTS = path.join(__dirname, '..', '..', '..');

const dataGraphLane = readFileSync(
  path.join(COMPONENTS, 'generation_v2', 'GenerationForm.tsx'),
  'utf-8'
);
const formGraphLane = readFileSync(
  path.join(COMPONENTS, 'form-graph', 'generation', 'BaseGenerationForm.tsx'),
  'utf-8'
);

describe('both generation lanes', () => {
  it('start the content-generation tour', () => {
    expect(dataGraphLane).toContain('useGenerationTour()');
    expect(formGraphLane).toContain('useGenerationTour()');
  });

  it.each(['<GrokEcosystemAlert', '<SeedanceImg2VidAlert', '<ConnectedReadyAlert'])(
    'mount %s',
    (mount) => {
      expect(dataGraphLane).toContain(mount);
      expect(formGraphLane).toContain(mount);
    }
  );

  it('give the workflow and ecosystem pickers their compatibility props', () => {
    for (const source of [dataGraphLane, formGraphLane]) {
      expect(source).toContain('isCompatible={compatibility.isWorkflowCompatible}');
      expect(source).toContain('isCompatible={compatibility.isEcosystemKeyCompatible}');
      expect(source).toContain('getTargetWorkflow={(key) => compatibility.getTargetWorkflow');
    }
  });
});
