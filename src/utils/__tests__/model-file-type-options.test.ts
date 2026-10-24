import { describe, expect, it } from 'vitest';
import { getModelFileTypeOptions } from '~/utils/file-display-helpers';

const values = (options: { value: string }[]) => options.map((option) => option.value);
const labelOf = (options: { value: string; label: string }[], value: string) =>
  options.find((option) => option.value === value)?.label;

describe('getModelFileTypeOptions', () => {
  it('offers only the types the extension can be', () => {
    const options = values(getModelFileTypeOptions('config.yaml'));
    expect(options).toContain('Config');
    expect(options).not.toContain('Model');
  });

  it('keeps the current type selectable even when the extension would exclude it', () => {
    // A legacy file must not render as a blank Select.
    expect(values(getModelFileTypeOptions('config.yaml'))).not.toContain('VAE');
    expect(values(getModelFileTypeOptions('config.yaml', { currentType: 'VAE' }))).toContain('VAE');
  });

  it('restricts to the types it is given', () => {
    expect(
      values(getModelFileTypeOptions('model.safetensors', { types: ['Model', 'VAE'] }))
    ).toEqual(['Model', 'VAE']);
  });

  it('labels the generic Model option by the model type', () => {
    const options = getModelFileTypeOptions('model.safetensors', {
      types: ['Model'],
      modelType: 'TextualInversion',
    });
    expect(labelOf(options, 'Model')).toBe('Embedding');
  });

  it('prefers the ComfyUI label over the raw type name', () => {
    const options = getModelFileTypeOptions('upscaler.safetensors', { types: ['Upscaler'] });
    expect(labelOf(options, 'Upscaler')).toBe('Upscale Model');
  });
});
