import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';

// The recommended range is painted on the track itself (turbo LoRAs supply one for CFG and steps);
// the band is the only element on the track with an inline position.
const bandOf = (slider: Element) => slider.querySelector<HTMLElement>('[style*="left"]');

describe('SliderInput', () => {
  test('paints the recommended range on the track', async () => {
    renderWithProviders(
      <SliderInput
        label="CFG Scale"
        value={5}
        min={1}
        max={15}
        step={0.5}
        recommended={{ min: 4, max: 7 }}
        onChange={vi.fn()}
      />
    );
    const slider = page.getByRole('slider', { name: 'CFG Scale' });
    await expect.element(slider).toBeInTheDocument();

    // 4–7 on a 1–15 track starts 3/14 of the way along and spans another 3/14.
    const band = bandOf(slider.element());
    expect(parseFloat(band?.style.left ?? '')).toBeCloseTo(21.43, 1);
    expect(parseFloat(band?.style.width ?? '')).toBeCloseTo(21.43, 1);
  });

  test('paints no range when none is recommended', async () => {
    renderWithProviders(
      <SliderInput label="Steps" value={25} min={10} max={50} step={1} onChange={vi.fn()} />
    );
    const slider = page.getByRole('slider', { name: 'Steps' });
    await expect.element(slider).toBeInTheDocument();
    expect(bandOf(slider.element())).toBeNull();
  });

  test('commits a key press as one step', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SliderInput label="CFG Scale" value={5} min={1} max={15} step={0.5} onChange={onChange} />
    );
    const slider = page.getByRole('slider', { name: 'CFG Scale' });
    await expect.element(slider).toBeInTheDocument();
    (slider.element() as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith(5.5);
  });
});
