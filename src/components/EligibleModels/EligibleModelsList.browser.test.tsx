import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const { EligibleModelsList } = await import('~/components/EligibleModels/EligibleModelsList');

const model = (versionId: number, name: string) => ({
  id: versionId * 10,
  name,
  versionId,
  versionName: `v${versionId}`,
  baseModel: 'SDXL 1.0',
  image: null,
});
const models = [model(1, 'Gyroid'), model(2, 'Not In Generator')];

const generateButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Generate with"]'),
];

describe('EligibleModelsList', () => {
  test('links each model to its version page', async () => {
    renderWithProviders(<EligibleModelsList models={models} />);

    await vi.waitFor(() => expect(document.body.textContent).toContain('Not In Generator'));
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/models/10'),
        expect.stringContaining('/models/20'),
      ])
    );
    expect(generateButtons()).toHaveLength(0);
  });

  test('offers generate only on models that can generate, with that model', async () => {
    const onGenerate = vi.fn();
    renderWithProviders(
      <EligibleModelsList
        models={models}
        onGenerate={onGenerate}
        canGenerate={(m) => m.versionId === 1}
      />
    );

    await vi.waitFor(() => expect(generateButtons()).toHaveLength(1));
    expect(generateButtons()[0].getAttribute('aria-label')).toBe('Generate with Gyroid');
    generateButtons()[0].click();
    expect(onGenerate).toHaveBeenCalledWith(models[0]);
  });
});
