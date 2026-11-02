import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// Which workflow control renders where is this file's question; the controls themselves are
// WorkflowInput's tests, so they are stand-ins here.
vi.mock('~/components/generation_v2/inputs/WorkflowInput', () => ({
  WorkflowInput: () => <div>Category icons</div>,
  WorkflowPicker: ({ onBack }: { onBack?: () => void }) => (
    <div>
      Workflow card
      {onBack && <button onClick={onBack}>Back</button>}
    </div>
  ),
  SelectedWorkflowDisplay: () => <div>Workflow display</div>,
}));

import { WorkflowModes, WorkflowRow } from '~/components/form-graph/generation/WorkflowRow';

const renderRow = (mobile: boolean, workflow = 'txt2img', onBack?: () => void) =>
  renderWithProviders(
    <WorkflowRow
      mobile={mobile}
      workflow={workflow}
      onChange={vi.fn()}
      onBack={onBack}
      ecosystemInput={<div>Ecosystem</div>}
    />
  );

describe('WorkflowRow', () => {
  test('on a phone the workflow card sits above the ecosystem, with no category icons', async () => {
    const onBack = vi.fn();
    renderRow(true, 'txt2img', onBack);

    await expect.element(page.getByText('Ecosystem')).toBeInTheDocument();
    await expect.element(page.getByText('Category icons')).not.toBeInTheDocument();
    const card = page.getByText('Workflow card').element();
    const ecosystem = page.getByText('Ecosystem').element();
    expect(card.compareDocumentPosition(ecosystem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await page.getByRole('button', { name: 'Back' }).click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('elsewhere it is the category icons beside the ecosystem, with no card', async () => {
    renderRow(false);

    await expect.element(page.getByText('Category icons')).toBeInTheDocument();
    await expect.element(page.getByText('Ecosystem')).toBeInTheDocument();
    await expect.element(page.getByText('Workflow card')).not.toBeInTheDocument();
  });

  test.each(['img2meta', 'prompt:enhance'])(
    'on a phone %s keeps its own display, so the row has no card',
    async (workflow) => {
      renderRow(true, workflow);

      await expect.element(page.getByText('Ecosystem')).toBeInTheDocument();
      await expect.element(page.getByText('Workflow card')).not.toBeInTheDocument();
    }
  );
});

describe('WorkflowModes', () => {
  const modes = [
    { label: 'Standard', value: 'img2vid' },
    { label: 'First/Last', value: 'img2vid:first-last' },
  ];

  test('on desktop it shows the selected workflow, then its modes', async () => {
    renderWithProviders(
      <WorkflowModes mobile={false} workflow="img2vid" modes={modes} onChange={vi.fn()} />
    );

    await expect.element(page.getByText('Workflow display')).toBeInTheDocument();
    await expect.element(page.getByText('First/Last')).toBeInTheDocument();
  });

  test('on a phone the card shows the workflow, so only the modes remain', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <WorkflowModes mobile workflow="img2vid" modes={modes} onChange={onChange} />
    );

    await page.getByText('First/Last').click();
    expect(onChange).toHaveBeenCalledWith('img2vid:first-last');
    await expect.element(page.getByText('Workflow display')).not.toBeInTheDocument();
  });

  test('on a phone with no modes it renders nothing, leaving no gap', async () => {
    renderWithProviders(
      <div data-testid="slot">
        <span>ready</span>
        <WorkflowModes mobile workflow="txt2img" modes={[]} onChange={vi.fn()} />
      </div>
    );

    await expect.element(page.getByText('ready')).toBeInTheDocument();
    expect(page.getByTestId('slot').element().children).toHaveLength(1);
  });
});
