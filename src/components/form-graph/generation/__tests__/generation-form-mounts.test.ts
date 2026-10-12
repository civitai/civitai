import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Alerts and hooks the generation form must MOUNT. Every one below was found absent from
 * this form by the 2026-09-23 lane sweep (docs/form-graph-lane-parity-sweep.md), back when
 * a second lane existed to compare it against. With that lane gone there is nothing left to
 * diff it with, so the finding is pinned as a presence assertion instead.
 *
 * Source text rather than rendering: the defect is "the call site is absent", which source
 * can answer, and rendering the form needs the whole provider stack.
 */

const COMPONENTS = path.join(__dirname, '..', '..', '..');

/**
 * Comments are stripped before asserting, because commenting a mount out IS the
 * regression. A bare presence check is satisfied by a mount wrapped in a JSX
 * comment, which renders nothing at all.
 *
 * Approximate on purpose — a line comment is only stripped at the start of a line, so a
 * `//` inside a URL survives. Over-stripping would cause a false FAILURE, which is
 * visible; under-stripping is what caused the false pass.
 */
function stripComments(src: string): string {
  return src.replace(/{?\/\*[\s\S]*?\*\/}?/g, ' ').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...rel: string[]) =>
  stripComments(readFileSync(path.join(COMPONENTS, ...rel), 'utf-8'));

const lane = read('form-graph', 'generation', 'BaseGenerationForm.tsx');
const footer = read('form-graph', 'generation', 'FormFooter.tsx');
const imageBody = read('form-graph', 'generation', 'ImageGenerationForm.tsx');
const audioBody = read('form-graph', 'generation', 'AudioGenerationForm.tsx');

describe('the generation form', () => {
  // The stripper runs over every file below, so a bug in it would empty them and make
  // every `toContain` fail — loud. This names the cause instead of leaving four
  // mysterious failures.
  it('POSITIVE CONTROL — the sources were read and survived comment stripping', () => {
    for (const [name, src] of Object.entries({ lane, footer, imageBody, audioBody })) {
      expect(src.length, `${name} came back empty`).toBeGreaterThan(500);
      expect(src, `${name} lost its JSX`).toContain('return');
    }
  });

  it('starts the content-generation tour', () => {
    expect(lane).toContain('useGenerationTour()');
  });

  it.each(['<GrokEcosystemAlert', '<SeedanceImg2VidAlert'])('mounts %s', (mount) => {
    expect(lane).toContain(mount);
  });

  // The download alert lives in the footer beside the other pre-submit warnings, wrapped there
  // so it can be given the form's own WhatIf context.
  it('mounts the download alert from the footer', () => {
    expect(footer).toContain('<DownloadWarning />');
    expect(footer).toContain('DownloadReadyAlert');
  });

  // Sweep finding 6. The alert takes no props and self-gates on isModerator, so absence is the
  // whole defect — a moderator simply never learns a preprocessor is failing.
  it('flags preprocessors missing examples', () => {
    expect(imageBody).toContain('<MissingPreprocessorExamplesAlert />');
  });

  // Sweep finding 5. One mount per output type, not one for the form: audio declares `model` and
  // no `resources`/`vae`, so it reports on the checkpoint alone. model3d declares none of the
  // three, so there is nothing for it to report and no mount is expected there.
  it('warns about unstable and restricted resources on every output type that has any', () => {
    for (const body of [imageBody, audioBody]) {
      expect(body).toContain('<ResourceAlerts');
    }
  });

  it('gives the workflow and ecosystem pickers their compatibility props', () => {
    expect(lane).toContain('isCompatible={compatibility.isWorkflowCompatible}');
    expect(lane).toContain('isCompatible={compatibility.isEcosystemKeyCompatible}');
    expect(lane).toContain('getTargetWorkflow={(key) => compatibility.getTargetWorkflow');
  });
});
