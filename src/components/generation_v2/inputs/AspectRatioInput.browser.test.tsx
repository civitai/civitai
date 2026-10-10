import { afterEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { AspectRatioInput } from '~/components/generation_v2/inputs/AspectRatioInput';
import { sideRange } from '~/components/generation_v2/inputs/CustomDimensionsModal';
import {
  CUSTOM_ASPECT_RATIO,
  sd1AspectRatioBuckets,
  sd1CustomDimensionLimits,
  sdxlCustomDimensionLimits,
  sdxlFullAspectRatioBuckets,
} from '~/shared/constants/generation.constants';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as SizePresetsModule from '~/components/generation_v2/inputs/useSizePresets';

// Saved sizes come from tRPC behind useSizePresets; the picker and modal only read
// what it returns, so the tests drive it directly. Signed out by default: no saves.
const sizePresets = vi.hoisted(() => ({
  presets: [] as { id: number; width: number; height: number; fits: boolean }[],
  canSave: false,
  saving: false,
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('~/components/generation_v2/inputs/useSizePresets', async (importOriginal) => ({
  ...(await importOriginal<typeof SizePresetsModule>()),
  useSizePresets: () => sizePresets,
}));

// The picker imposes one order — widest first — whatever order an ecosystem
// declares its options in, and a pick from "More" lands in its place in that
// order rather than in the row's last slot. The row is a Mantine SegmentedControl,
// one radio per segment; reading their values in DOM order reads the row.

const rowValues = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    .map((input) => input.value)
    .filter((value) => value !== '__more__');

const toValue = (value: string) => {
  const option = sdxlFullAspectRatioBuckets.find((o) => o.value === value)!;
  return { value, width: option.width, height: option.height };
};

function renderPicker(props: {
  value?: string;
  options: { value: string; width?: number; height?: number }[];
  priorityOptions?: string[];
}) {
  renderWithProviders(
    // Wide enough that maxVisible (5), not the container, caps the row.
    <div style={{ width: 800 }}>
      <AspectRatioInput
        value={props.value ? toValue(props.value) : undefined}
        options={props.options}
        priorityOptions={props.priorityOptions}
        onChange={vi.fn()}
      />
    </div>
  );
}

describe('AspectRatioInput order', () => {
  test('sorts a portrait-first list widest first', async () => {
    renderPicker({
      options: [
        { value: '9:16', width: 768, height: 1344 },
        { value: '1:1', width: 1024, height: 1024 },
        { value: '16:9', width: 1344, height: 768 },
      ],
    });

    await vi.waitFor(() => expect(rowValues()).toEqual(['16:9', '1:1', '9:16']));
  });

  test('shows the priority row widest first, whatever order it was declared in', async () => {
    renderPicker({
      value: '1:1',
      options: [...sdxlFullAspectRatioBuckets].reverse(),
      priorityOptions: ['2:3', '1:1', '3:2'],
    });

    await vi.waitFor(() => expect(rowValues()).toEqual(['3:2', '1:1', '2:3']));
  });

  test('without priorityOptions, a long list fills the row from its sorted middle', async () => {
    renderPicker({
      value: '1:1',
      // Declared tallest-first; the row must not depend on that.
      options: [...sdxlFullAspectRatioBuckets].reverse(),
    });

    // maxVisible 5 = four options + More, taken from 16:9..2:3 (the sorted middle).
    await vi.waitFor(() => expect(rowValues()).toEqual(['16:9', '3:2', '4:3', '1:1']));
  });

  test.each([
    ['21:9', ['21:9', '1:1', '2:3']],
    ['4:3', ['4:3', '1:1', '2:3']],
    ['3:4', ['3:2', '1:1', '3:4']],
    ['9:21', ['3:2', '1:1', '9:21']],
  ])('a pick of %s from More replaces its nearest neighbour in place', async (picked, row) => {
    renderPicker({
      value: picked,
      options: sdxlFullAspectRatioBuckets,
      priorityOptions: ['3:2', '1:1', '2:3'],
    });

    await vi.waitFor(() => expect(rowValues()).toEqual(row));
  });
});

describe('AspectRatioInput "More"', () => {
  // Click the More segment's label: Mantine hides the radio itself.
  const openMore = () => userEvent.click(page.getByText('More'));

  test('opens a bottom sheet titled with the label on a phone, and a pick closes it', async () => {
    await page.viewport(360, 780);
    const onChange = vi.fn();
    renderWithProviders(
      <AspectRatioInput
        label="Aspect Ratio"
        value={toValue('1:1')}
        options={sdxlFullAspectRatioBuckets}
        priorityOptions={['3:2', '1:1', '2:3']}
        onChange={onChange}
      />
    );

    await openMore();
    const sheet = page.getByRole('dialog');
    expect(document.querySelector('.mantine-Drawer-root')).not.toBeNull();
    await expect.element(sheet.getByText('Aspect Ratio')).toBeInTheDocument();
    // Sheet rows are sized for a thumb; the desktop popover keeps the compact size.
    await expect.element(sheet.getByText('21:9', { exact: true })).toHaveClass('text-base');

    await userEvent.click(sheet.getByText('21:9'));
    expect(onChange).toHaveBeenCalledWith({ value: '21:9', width: 1536, height: 640 });
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps the popover on desktop', async () => {
    await page.viewport(1440, 900);
    renderWithProviders(
      <AspectRatioInput
        label="Aspect Ratio"
        value={toValue('1:1')}
        options={sdxlFullAspectRatioBuckets}
        priorityOptions={['3:2', '1:1', '2:3']}
        onChange={vi.fn()}
      />
    );

    await openMore();
    await expect.element(page.getByText('1536x640')).toBeInTheDocument();
    await expect.element(page.getByText('21:9', { exact: true }).last()).toHaveClass('text-sm');
    expect(document.querySelector('.mantine-Drawer-root')).toBeNull();
  });
});

describe('AspectRatioInput "Custom"', () => {
  // dialogStore is a module-level store that outlives each render: a modal one test
  // leaves open would be reused (same id) by the next, with the old test's callbacks.
  afterEach(() => {
    useDialogStore.getState().closeAll();
    Object.assign(sizePresets, { presets: [], canSave: false });
    vi.clearAllMocks();
  });

  const custom = (width: number, height: number) => ({
    value: CUSTOM_ASPECT_RATIO,
    width,
    height,
  });

  function renderCustom(value: { value: string; width: number; height: number }) {
    const onChange = vi.fn();
    renderWithProviders(
      <div style={{ width: 800 }}>
        <AspectRatioInput
          label="Aspect Ratio"
          value={value}
          options={sdxlFullAspectRatioBuckets}
          priorityOptions={['3:2', '1:1', '2:3']}
          custom={sdxlCustomDimensionLimits}
          onChange={onChange}
        />
        {/* The size editor is a dialogStore modal; this is what mounts it. */}
        <DialogProvider />
      </div>
    );
    return onChange;
  }

  const modal = () => page.getByRole('dialog', { name: 'Custom size' });
  const customSegment = () => page.getByText('Custom', { exact: true });
  const readout = () => modal().getByTestId('custom-size-readout');
  const megapixels = () => modal().getByTestId('custom-size-megapixels');
  // The modal resolves a promise the picker awaits, so onChange lands a tick after the click.
  const apply = async (onChange: ReturnType<typeof vi.fn>) => {
    await userEvent.click(modal().getByRole('button', { name: 'Apply' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  };

  test('choosing Custom opens the modal on the size already chosen; Apply sends it', async () => {
    await page.viewport(1440, 900);
    const onChange = renderCustom(toValue('16:9'));

    await userEvent.click(page.getByText('More'));
    await userEvent.click(page.getByText('Width × height'));

    await expect.element(readout()).toHaveTextContent('1344 × 768');
    await expect.element(megapixels()).toHaveTextContent('0.98 MP');
    expect(onChange).not.toHaveBeenCalled();
    await apply(onChange);
    expect(onChange).toHaveBeenCalledWith(custom(1344, 768));
  });

  test('Cancel leaves the previous pick alone', async () => {
    await page.viewport(1440, 900);
    const onChange = renderCustom(toValue('1:1'));

    await userEvent.click(page.getByText('More'));
    await userEvent.click(page.getByText('Width × height'));
    await userEvent.click(modal().getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
    await expect.element(modal()).not.toBeInTheDocument();
  });

  test('clicking the selected Custom segment reopens the modal', async () => {
    const onChange = renderCustom(custom(992, 1408));

    await userEvent.click(customSegment());
    await expect.element(readout()).toHaveTextContent('992 × 1408');
    await expect.element(megapixels()).toHaveTextContent('1.33 MP');

    await userEvent.click(modal().getByRole('button', { name: 'Swap width and height' }));
    await apply(onChange);
    expect(onChange).toHaveBeenCalledWith(custom(1408, 992));
  });

  // The reported bug: 512 tall, the width box went past 1280 and snapped back,
  // because 2.5:1 caps it there. The slider's end now says so up front.
  test("each slider's range follows the other side", async () => {
    renderCustom(custom(1280, 512));
    await userEvent.click(customSegment());

    await expect.element(modal().getByText(/Up to 1280 at this height/)).toBeInTheDocument();

    // Raising the height lifts the width's ceiling.
    await userEvent.fill(modal().getByRole('textbox', { name: 'Height' }), '640');
    await expect.element(modal().getByText(/Up to 1280 at this height/)).not.toBeInTheDocument();
  });

  test('clicking a selected bucket opens nothing', async () => {
    renderCustom(toValue('1:1'));
    await userEvent.click(page.getByText('1:1', { exact: true }));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  // The slider spans every size a side can ever take; what the other side rules out
  // is greyed, and the thumb stops at its edge rather than the range shrinking.
  test('greys the part of a slider the other side rules out, and stops there', async () => {
    renderCustom(custom(1024, 512));
    await userEvent.click(customSegment());

    const widthZone = () => document.querySelector('[data-blocked-zone="width-end"]');
    await vi.waitFor(() => expect(widthZone()).not.toBeNull());

    // 512 tall caps the width at 1280 (2.5:1); End drives the thumb to the top of the
    // full range, and it stops at the grey zone's edge.
    const thumb = modal().getByRole('slider', { name: 'Width' });
    (thumb.element() as HTMLElement).focus();
    await userEvent.keyboard('{End}');
    await expect.element(readout()).toHaveTextContent('1280 × 512');

    // Raising the height shrinks the width's grey zone, then removes it.
    await userEvent.fill(modal().getByRole('textbox', { name: 'Height' }), '1024');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-blocked-zone="width-end"]')).toHaveLength(0)
    );
  });

  // Two levels: past the recommended 1MP warns and still applies; the hard cap is enforced.
  test('warns above the recommended size, but still applies it', async () => {
    const onChange = renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());
    await expect.element(modal().getByText(/Above the recommended/)).not.toBeInTheDocument();

    await userEvent.fill(modal().getByRole('textbox', { name: 'Width' }), '1536');
    await userEvent.fill(modal().getByRole('textbox', { name: 'Height' }), '1536');
    await expect.element(modal().getByText(/Above the recommended 1.00 MP/)).toBeInTheDocument();

    await apply(onChange);
    expect(onChange).toHaveBeenCalledWith(custom(1536, 1536));
  });

  // The ratio buttons change the shape and keep the size, like Forge's with its lock on.
  test('a ratio button reshapes at the current size', async () => {
    const onChange = renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await userEvent.click(modal().getByRole('button', { name: '16:9' }));
    // 1024² at 16:9 is 1365 × 768; snapped to 32, 1376 × 768.
    await expect.element(readout()).toHaveTextContent('1376 × 768');
    await expect
      .element(modal().getByRole('button', { name: '16:9' }))
      .toHaveAttribute('aria-pressed', 'true');

    await apply(onChange);
    expect(onChange).toHaveBeenCalledWith(custom(1376, 768));
  });

  test('the ratio buttons follow a portrait size', async () => {
    renderCustom(custom(768, 1344));
    await userEvent.click(customSegment());

    // Portrait: the row reads 9:16, and 9:16 is the current shape.
    await expect
      .element(modal().getByRole('button', { name: '9:16' }))
      .toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(modal().getByRole('button', { name: '1:1' }));
    await expect.element(readout()).toHaveTextContent('1024 × 1024');
  });

  test('a typed side snaps to 32 when the box loses focus', async () => {
    renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await userEvent.fill(modal().getByRole('textbox', { name: 'Width' }), '1000');
    await userEvent.tab();
    // The readout shows what Apply would send.
    await expect.element(readout()).toHaveTextContent('992 × 1024');
  });

  test('the sliders move independently', async () => {
    renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await userEvent.fill(modal().getByRole('textbox', { name: 'Width' }), '1344');
    await expect.element(readout()).toHaveTextContent('1344 × 1024');
  });

  // Saved sizes: per size group, offered in the modal and straight from More.
  test('Save stores the size Apply would send', async () => {
    sizePresets.canSave = true;
    renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await userEvent.fill(modal().getByRole('textbox', { name: 'Width' }), '1000');
    await userEvent.click(modal().getByRole('button', { name: 'Save size' }));
    expect(sizePresets.save).toHaveBeenCalledWith({ width: 992, height: 1024 });
  });

  test('signed out, there is no Save', async () => {
    renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());
    await expect.element(readout()).toBeInTheDocument();
    await expect
      .element(modal().getByRole('button', { name: 'Save size' }))
      .not.toBeInTheDocument();
  });

  test('the modal lists saved sizes smallest to largest', async () => {
    Object.assign(sizePresets, {
      canSave: true,
      // Newest first, as the server returns them.
      presets: [
        { id: 1, width: 1536, height: 640, fits: true },
        { id: 2, width: 1536, height: 1536, fits: true },
        { id: 3, width: 832, height: 1216, fits: true },
      ],
    });
    renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await expect.element(modal().getByText('Saved', { exact: true })).toBeInTheDocument();
    const order = [...document.querySelectorAll('[role=dialog] button')]
      .map((b) => b.textContent ?? '')
      .filter((text) => /^\d+ × \d+$/.test(text));
    expect(order).toEqual(['1536 × 640', '832 × 1216', '1536 × 1536']);
  });

  test('a saved size applies from the modal, and can be removed there', async () => {
    Object.assign(sizePresets, {
      canSave: true,
      presets: [{ id: 5, width: 1536, height: 640, fits: true }],
    });
    renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await userEvent.click(modal().getByRole('button', { name: '1536 × 640', exact: true }));
    await expect.element(readout()).toHaveTextContent('1536 × 640');

    await userEvent.click(modal().getByRole('button', { name: 'Remove saved size 1536 × 640' }));
    expect(sizePresets.remove).toHaveBeenCalledWith(5);
  });

  test('More splits into the model presets and the user sizes', async () => {
    await page.viewport(1440, 900);
    Object.assign(sizePresets, {
      canSave: true,
      presets: [{ id: 5, width: 1536, height: 640, fits: true }],
    });
    renderCustom(toValue('1:1'));

    await userEvent.click(page.getByText('More'));
    await expect.element(page.getByText('Presets', { exact: true })).toBeInTheDocument();
    // Custom and the saved size share the second heading.
    await expect.element(page.getByText('Custom', { exact: true }).last()).toBeInTheDocument();
    await expect.element(page.getByText('1536 × 640')).toBeInTheDocument();
  });

  // One list per user: a size this model can't take is greyed in the modal, with
  // why, and left out of More.
  test("a saved size this model can't take is greyed in the modal and absent from More", async () => {
    await page.viewport(1440, 900);
    Object.assign(sizePresets, {
      canSave: true,
      presets: [{ id: 6, width: 2048, height: 2048, fits: false }],
    });
    renderCustom(custom(1024, 1024));

    await userEvent.click(customSegment());
    const saved = modal().getByRole('button', { name: '2048 × 2048', exact: true });
    await expect.element(saved).toBeDisabled();
    await expect
      .element(saved)
      .toHaveAttribute('title', expect.stringContaining("Doesn't fit this model"));
    await userEvent.click(modal().getByRole('button', { name: 'Cancel' }));

    await userEvent.click(page.getByText('More'));
    await expect.element(page.getByText('2048 × 2048')).not.toBeInTheDocument();
  });

  // SD1 has three ratios: with Custom and a saved size the row had room for all
  // five, so the saved size became a segment and More vanished.
  test('a saved size never becomes a segment, even with room in the row', async () => {
    Object.assign(sizePresets, {
      canSave: true,
      presets: [{ id: 7, width: 512, height: 640, fits: true }],
    });
    renderWithProviders(
      <div style={{ width: 800 }}>
        <AspectRatioInput
          value={{ value: '1:1', width: 512, height: 512 }}
          options={sd1AspectRatioBuckets}
          custom={sd1CustomDimensionLimits}
          onChange={vi.fn()}
        />
      </div>
    );

    await vi.waitFor(() => expect(rowValues()).toEqual(['3:2', '1:1', '2:3', 'custom']));
    await expect.element(page.getByText('More')).toBeInTheDocument();
  });

  test('a saved size under More sets the size in one tap, no modal', async () => {
    await page.viewport(1440, 900);
    Object.assign(sizePresets, {
      canSave: true,
      presets: [{ id: 5, width: 1536, height: 640, fits: true }],
    });
    const onChange = renderCustom(toValue('1:1'));

    await userEvent.click(page.getByText('More'));
    await userEvent.click(page.getByText('1536 × 640'));

    expect(onChange).toHaveBeenCalledWith(custom(1536, 640));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
  });

  test('Apply fits a typed out-of-range size instead of sending it', async () => {
    const onChange = renderCustom(custom(1024, 1024));
    await userEvent.click(customSegment());

    await userEvent.fill(modal().getByRole('textbox', { name: 'Width' }), '4000');
    await apply(onChange);

    const sent = onChange.mock.calls.at(-1)![0];
    expect(sent.width % 32).toBe(0);
    expect(sent.width * sent.height).toBeLessThanOrEqual(sdxlCustomDimensionLimits.maxArea);
    expect(sent.width / sent.height).toBeLessThanOrEqual(sdxlCustomDimensionLimits.maxRatio);
  });
});

describe('sideRange', () => {
  const L = sdxlCustomDimensionLimits;

  test.each([
    [512, 512, 1280, 'ratio'],
    [768, 512, 1920, 'ratio'],
    [1024, 512, 2048, 'side'],
    [1536, 640, 1536, 'area'],
  ] as const)('at %i the other side runs %i–%i, capped by %s', (other, min, max, limitedBy) => {
    expect(sideRange(other, L)).toMatchObject({ min, max, limitedBy });
  });

  test('every pair inside both ranges is accepted unchanged', () => {
    // Up to the longest a side can be under the joint caps.
    let longest: number = L.minSide;
    for (let x = L.minSide; x <= L.maxSide; x += L.step)
      longest = Math.max(longest, sideRange(x, L).max);
    for (let h = L.minSide; h <= longest; h += L.step) {
      const w = sideRange(h, L);
      for (const width of [w.min, w.max]) {
        const back = sideRange(width, L);
        expect(h).toBeGreaterThanOrEqual(back.min);
        expect(h).toBeLessThanOrEqual(back.max);
      }
    }
  });
});
