import { describe, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { renderWithProviders } from '../../../../test/component-setup';
import { useWizardAutoResume } from '~/components/Resource/Wizard/useWizardAutoResume';

/**
 * Regression cover for the model-version wizard jumping to the post step as soon
 * as the FIRST of several files finished uploading: that upload invalidates the
 * version query, `hasFiles` flips, and an unguarded resume effect re-fired.
 */

function Harness({
  initialReady,
  onResume,
}: {
  initialReady: boolean;
  onResume: (step: number) => void;
}) {
  const [ready, setReady] = useState(initialReady);
  const [hasFiles, setHasFiles] = useState(false);

  useWizardAutoResume({
    ready,
    resolveStep: () => (hasFiles ? 3 : 2),
    onResume,
  });

  return (
    <div>
      <button data-testid="load" onClick={() => setReady(true)}>
        load
      </button>
      <button data-testid="complete-upload" onClick={() => setHasFiles(true)}>
        complete upload
      </button>
    </div>
  );
}

function click(testId: string) {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing button: ${testId}`);
  el.click();
}

describe('useWizardAutoResume', () => {
  test('resumes once the data is ready', async () => {
    const onResume = vi.fn();
    await renderWithProviders(<Harness initialReady={true} onResume={onResume} />);

    await vi.waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume).toHaveBeenCalledWith(2);
  });

  test('does not resume while the data is still loading', async () => {
    const onResume = vi.fn();
    await renderWithProviders(<Harness initialReady={false} onResume={onResume} />);

    expect(onResume).not.toHaveBeenCalled();

    click('load');
    await vi.waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
  });

  test('a mid-session input change does NOT push the user forward again', async () => {
    const onResume = vi.fn();
    await renderWithProviders(<Harness initialReady={true} onResume={onResume} />);

    await vi.waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume).toHaveBeenCalledWith(2);

    // First of several uploads lands → version query invalidated → `hasFiles` flips.
    click('complete-upload');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalledWith(3);
  });
});
