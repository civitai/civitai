import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// Where the cards' parts go is this file's question; the workflow control itself is
// WorkflowPicker's tests, so it is a stand-in here.
vi.mock('~/components/generation_v2/inputs/WorkflowPicker', () => ({
  WorkflowPicker: ({ onBack }: { onBack?: () => void }) => (
    <div>
      Workflow card
      {onBack && <button onClick={onBack}>Back</button>}
    </div>
  ),
}));

import { WorkflowRow } from '~/components/form-graph/generation/WorkflowRow';
import {
  GenerationSetupModel,
  GenerationSlotProvider,
} from '~/components/generation_v2/GenerationLayout';

const modes = [
  { label: 'Standard', value: 'img2vid' },
  { label: 'First/Last', value: 'img2vid:first-last' },
];

// The form after the row, as each output form draws it: its model and the model's versions, into
// the model card.
const renderRow = (
  workflow = 'img2vid',
  { onBack, onChange = vi.fn() }: { onBack?: () => void; onChange?: (key: string) => void } = {}
) =>
  renderWithProviders(
    <GenerationSlotProvider>
      <WorkflowRow
        workflow={workflow}
        onChange={onChange}
        onBack={onBack}
        modes={modes}
        ecosystemInput={<div>Ecosystem</div>}
      />
      <GenerationSetupModel>
        <div>Model card</div>
      </GenerationSetupModel>
    </GenerationSlotProvider>
  );

describe('WorkflowRow', () => {
  test("the form's model lands in the model card under the ecosystem; a mode and Back report", async () => {
    const onBack = vi.fn();
    const onChange = vi.fn();
    renderRow('img2vid', { onBack, onChange });

    // The model is drawn by the form after the row, through the slot, into the ecosystem's card.
    await expect.element(page.getByText('Model card')).toBeInTheDocument();
    const modelCard = page.getByText('Ecosystem').element().parentElement!;
    expect(modelCard.contains(page.getByText('Model card').element())).toBe(true);

    await page.getByRole('radio', { name: 'First/Last' }).click();
    expect(onChange).toHaveBeenCalledWith('img2vid:first-last');
    await page.getByRole('button', { name: 'Back' }).click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('a variant of a workflow selects the mode it is a variant of', async () => {
    // img2vid:first-last is not a mode of its own: it is img2vid with a last frame.
    renderWithProviders(
      <WorkflowRow
        workflow="img2vid:first-last"
        onChange={vi.fn()}
        modes={[
          { label: 'Text', value: 'txt2vid' },
          { label: 'Image', value: 'img2vid' },
        ]}
        ecosystemInput={<div>Ecosystem</div>}
      />
    );

    await expect
      .element(page.getByRole('radio', { name: 'Image' }))
      .toHaveAttribute('aria-checked', 'true');
    await expect
      .element(page.getByRole('radio', { name: 'Text' }))
      .toHaveAttribute('aria-checked', 'false');
  });

  test('a workflow with no modes draws no mode row', async () => {
    renderWithProviders(
      <WorkflowRow
        workflow="img2img"
        onChange={vi.fn()}
        modes={[]}
        ecosystemInput={<div>Ecosystem</div>}
      />
    );

    await expect.element(page.getByText('Ecosystem')).toBeInTheDocument();
    await expect.element(page.getByRole('radiogroup', { name: 'Mode' })).not.toBeInTheDocument();
  });
});
