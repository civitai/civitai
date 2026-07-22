import { describe, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { useWizardAutoResume } from '~/components/Resource/Wizard/useWizardAutoResume';

/**
 * Hook-level cover. The wizard-level regression for the reported bug (the post
 * step stealing the user mid-upload) lives in
 * `ModelVersionWizard.autoResume.browser.test.tsx`.
 */

function Harness({
  initialReady,
  onResume,
}: {
  initialReady: boolean;
  onResume: (targetStep: number) => void;
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
      <span data-testid="has-files">{String(hasFiles)}</span>
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

    click('complete-upload');
    await expect.element(page.getByTestId('has-files')).toHaveTextContent('true');

    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
