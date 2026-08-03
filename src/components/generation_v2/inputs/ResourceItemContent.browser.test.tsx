import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// =============================================================================
// ResourceItemContent — pure-helper exhaustion + real-component render
// =============================================================================
//
// Two layers, with honestly-different fidelity:
//
// LAYER 1 — the 5 PURE helpers (getResourceCompatibility / getResourceStatus /
//   getStatusClasses / isResourceDisabled / shouldShowModelLink). NO render, NO
//   mocks: these are plain functions imported from the REAL module. This is the
//   highest-value, fully-faithful layer — every branch is exercised against the
//   real implementation. A copier should note: because the rest of the file
//   mocks three child modules (below) but NOT ResourceItemContent itself, these
//   helper imports are the genuine exports.
//
// LAYER 2 — the REAL `ResourceItemContent` React component, rendered under the
//   scaffold providers (MantineProvider + QueryClient + next/router). To stand
//   it up we satisfy ONE required context and BOUNDARY-STUB three heavy leaf
//   children. What each mock shadows, and why:
//
//   * useAppContext (`~/providers/AppProvider`) — a REQUIRED context hook that
//     THROWS when there's no <AppProvider>. The component reads ONLY `domain`
//     (verified by grep: the sole references are `const { domain } = ...` and
//     `!domain.green && ...`). So the mock returns just `{ domain }` cast `as any`;
//     every other AppContext field is intentionally omitted — nothing in this
//     component reads them, so a fuller fixture would add no coverage. The mock
//     is what makes `isSfwOnly = !domain.green && (sfwOnly || minor)` drivable.
//
//   * NumberSlider (`~/libs/form/components/NumberSlider`) — the real one is a
//     Mantine Slider+NumberInput composite with its own focus/precision/preset
//     state. We replace it with a thin stub that SURFACES the props the strength
//     branch wires (value / min / max / disabled) and exposes an
//     `onChange`-driving button, so the hasStrength gate, the min/max
//     (isSameMinMaxStrength) math, the `disabled` pass-through, and the
//     `onStrengthChange(strength ?? 1)` callback stay observable. SHADOWS: the
//     real slider's drag/keyboard interaction + its internal value clamping —
//     not under test here.
//
//   * EdgeMedia2 (`~/components/EdgeMedia/EdgeMedia`) — drags in
//     BrowserSettingsProvider + the edge-image/-video URL pipeline. Stubbed to a
//     thin <img> echoing `src`, just enough to confirm the image branch renders.
//     SHADOWS: all real CF-image URL building / animation logic.
//
//   Mantine is NOT mocked (resolve.dedupe handles dual-React at the scaffold).
//
// SCOPE CAVEATS (so nobody over-trusts Layer 2):
//   - Fixtures are hand-built `as any`; nothing ENFORCES they match the real
//     GenerationResource shape, so a type drift wouldn't fail here.
//   - The status->indicator assertions key off each icon's tabler class
//     (`tabler-icon-*`) since the icons are nameless ThemeIcons inside HoverCards;
//     we assert exactly-one indicator by counting those classes. This pins the
//     wiring without adding aria-labels to the component (kept pristine).
//     partial and incompatible BOTH render an alert-triangle, so for those two
//     we additionally assert the ThemeIcon `color` attribute (yellow.7 vs red) —
//     the only thing distinguishing the two branches; the icon count alone lets
//     them swap silently. (A real a11y gap the test does NOT paper over: the
//     status ThemeIcons carry no accessible name, so SR users get the meaning
//     only via the mouse-hover tooltip. Adding a value-bearing aria-label to
//     each is a deliberate, tiny component change left out of this test PR.)
//   - getStatusClasses' returned class strings are applied by the CALLERS
//     (ResourceSelectInput/Multiple), not by ResourceItemContent itself, so
//     Layer 2 does not assert them — Layer 1 covers that helper directly.

// ---- Boundary stubs (hoisted; factories self-contained) ---------------------

vi.mock('~/libs/form/components/NumberSlider', () => ({
  NumberSlider: ({
    value,
    onChange,
    min,
    max,
    disabled,
  }: {
    value?: number;
    onChange?: (v?: number) => void;
    min?: number;
    max?: number;
    disabled?: boolean;
  }) => (
    <div
      data-testid="strength-slider"
      data-value={String(value)}
      data-min={String(min)}
      data-max={String(max)}
      data-disabled={String(!!disabled)}
    >
      <button
        type="button"
        data-testid="strength-set"
        onClick={() => onChange?.(0.5)}
      >
        set-strength
      </button>
    </div>
  ),
}));

vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia2: ({ src }: { src?: string }) => (
    <img data-testid="edge-media" src={src} alt="" />
  ),
}));

vi.mock('~/providers/AppProvider', () => ({
  useAppContext: vi.fn(),
}));

import {
  ResourceItemContent,
  getResourceCompatibility,
  getResourceStatus,
  getStatusClasses,
  isResourceDisabled,
  shouldShowModelLink,
} from './ResourceItemContent';
import { useAppContext } from '~/providers/AppProvider';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';

const appContextMock = vi.mocked(useAppContext);

// A fully-hydrated, compatible LORA resource. Override per test.
const makeResource = (over: Record<string, any> = {}): any => ({
  id: 555,
  name: 'v1.0',
  trainedWords: [],
  baseModel: 'SD1',
  canGenerate: true,
  hasAccess: true,
  minStrength: -1,
  maxStrength: 2,
  strength: 1,
  isOwnedByUser: false,
  isPrivate: false,
  model: { id: 42, name: 'My Cool Model', type: 'LORA', sfwOnly: false, minor: false },
  ...over,
});

// Count rendered tabler icons of a given suffix in the live DOM.
const countIcon = (suffix: string) =>
  document.querySelectorAll(`.tabler-icon-${suffix}`).length;

// The Mantine `color` prop is rendered as a `color="..."` attribute on the
// ThemeIcon root that wraps the icon svg. partial and incompatible BOTH render
// an alert-triangle, so the icon class alone can't tell them apart — the
// disambiguator is the ThemeIcon color (yellow.7 vs red). Return it.
const iconThemeColor = (suffix: string) =>
  document
    .querySelector(`.tabler-icon-${suffix}`)
    ?.closest('.mantine-ThemeIcon-root')
    ?.getAttribute('color');

// =============================================================================
// LAYER 1 — pure helpers (no render, no mocks)
// =============================================================================

describe('getResourceCompatibility', () => {
  test('no baseModel -> full', () => {
    expect(getResourceCompatibility(undefined, 'LORA', { resources: [] })).toBe('full');
  });

  test('no options.resources -> full', () => {
    expect(getResourceCompatibility('SD1', 'LORA', {})).toBe('full');
    expect(getResourceCompatibility('SD1', 'LORA', undefined)).toBe('full');
  });

  test('no config for this type -> full', () => {
    const options: ResourceSelectOptions = {
      resources: [{ type: 'Checkpoint', baseModels: ['SDXL'] }],
    };
    expect(getResourceCompatibility('SD1', 'LORA', options)).toBe('full');
  });

  test('config present but no baseModels && no partialSupport -> full', () => {
    const options: ResourceSelectOptions = { resources: [{ type: 'LORA' }] };
    expect(getResourceCompatibility('SD1', 'LORA', options)).toBe('full');
  });

  test('baseModel in baseModels -> full', () => {
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SD1', 'SDXL'] }],
    };
    expect(getResourceCompatibility('SD1', 'LORA', options)).toBe('full');
  });

  test('baseModel in partialSupport (not in baseModels) -> partial', () => {
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SDXL'], partialSupport: ['SD1'] }],
    };
    expect(getResourceCompatibility('SD1', 'LORA', options)).toBe('partial');
  });

  test('baseModel in neither list -> null', () => {
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SDXL'], partialSupport: ['Pony'] }],
    };
    expect(getResourceCompatibility('SD1', 'LORA', options)).toBeNull();
  });
});

describe('getResourceStatus', () => {
  test('canGenerate false + private + not owned -> private', () => {
    const r = makeResource({ canGenerate: false, isPrivate: true, isOwnedByUser: false });
    expect(getResourceStatus(r)).toBe('private');
  });

  test('canGenerate false + private + OWNED -> unavailable (not private)', () => {
    const r = makeResource({ canGenerate: false, isPrivate: true, isOwnedByUser: true });
    expect(getResourceStatus(r)).toBe('unavailable');
  });

  test('canGenerate false + not private -> unavailable', () => {
    const r = makeResource({ canGenerate: false, isPrivate: false });
    expect(getResourceStatus(r)).toBe('unavailable');
  });

  test('canGenerate true + compatibility null -> incompatible', () => {
    const r = makeResource({ baseModel: 'SD1', model: { id: 1, name: 'M', type: 'LORA' } });
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SDXL'] }],
    };
    expect(getResourceStatus(r, options)).toBe('incompatible');
  });

  test('canGenerate true + compatibility partial -> partial', () => {
    const r = makeResource({ baseModel: 'SD1', model: { id: 1, name: 'M', type: 'LORA' } });
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SDXL'], partialSupport: ['SD1'] }],
    };
    expect(getResourceStatus(r, options)).toBe('partial');
  });

  test('canGenerate true + compatibility full -> compatible', () => {
    const r = makeResource();
    expect(getResourceStatus(r)).toBe('compatible');
  });
});

describe('getStatusClasses', () => {
  test('partial -> yellow border+background', () => {
    expect(getStatusClasses('partial')).toEqual({
      border: 'border-yellow-5',
      background: 'bg-yellow-1 dark:bg-yellow-9/20',
    });
  });

  test.each(['incompatible', 'private', 'unavailable'] as const)(
    '%s -> red border+background',
    (status) => {
      expect(getStatusClasses(status)).toEqual({
        border: 'border-red-5',
        background: 'bg-red-1 dark:bg-red-9/20',
      });
    }
  );

  test('compatible -> empty object', () => {
    expect(getStatusClasses('compatible')).toEqual({});
  });
});

describe('isResourceDisabled', () => {
  test.each(['incompatible', 'private', 'unavailable'] as const)('%s -> true', (s) => {
    expect(isResourceDisabled(s)).toBe(true);
  });

  test.each(['compatible', 'partial'] as const)('%s -> false', (s) => {
    expect(isResourceDisabled(s)).toBe(false);
  });
});

describe('shouldShowModelLink', () => {
  test('owned -> true even when private', () => {
    expect(shouldShowModelLink({ isOwnedByUser: true, isPrivate: true } as any)).toBe(true);
  });

  test('public (not private) + not owned -> true', () => {
    expect(shouldShowModelLink({ isOwnedByUser: false, isPrivate: false } as any)).toBe(true);
  });

  test('private + not owned -> false', () => {
    expect(shouldShowModelLink({ isOwnedByUser: false, isPrivate: true } as any)).toBe(false);
  });
});

// =============================================================================
// LAYER 2 — real component render (useAppContext mocked, children stubbed)
// =============================================================================

describe('ResourceItemContent (render)', () => {
  beforeEach(() => {
    appContextMock.mockReset();
    // Component reads ONLY domain; green=false makes SFW indicators active.
    appContextMock.mockReturnValue({ domain: { green: false, blue: true, red: false } } as any);
  });

  test('partial status renders exactly the yellow alert-triangle indicator', async () => {
    const r = makeResource({ baseModel: 'SD1', model: { id: 1, name: 'M', type: 'LORA' } });
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SDXL'], partialSupport: ['SD1'] }],
    };
    renderWithProviders(<ResourceItemContent resource={r} options={options} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    // partial = exactly one IconAlertTriangle; no lock/ban/shield.
    expect(countIcon('alert-triangle')).toBe(1);
    expect(countIcon('lock')).toBe(0);
    expect(countIcon('ban')).toBe(0);
    expect(countIcon('shield')).toBe(0);
    // partial and incompatible share the alert-triangle icon — the disambiguator
    // is the YELLOW ThemeIcon (incompatible is red). Without this, routing a
    // partial resource through the incompatible (scary red) branch passes.
    expect(iconThemeColor('alert-triangle')).toBe('yellow.7');
  });

  test('incompatible status renders exactly one alert-triangle, no other indicators', async () => {
    const r = makeResource({ baseModel: 'SD1', model: { id: 1, name: 'M', type: 'Checkpoint' } });
    const options: ResourceSelectOptions = {
      resources: [{ type: 'Checkpoint', baseModels: ['SDXL'] }],
    };
    renderWithProviders(<ResourceItemContent resource={r} options={options} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    expect(countIcon('alert-triangle')).toBe(1);
    expect(countIcon('lock')).toBe(0);
    expect(countIcon('ban')).toBe(0);
    // RED disambiguates incompatible from the yellow partial branch.
    expect(iconThemeColor('alert-triangle')).toBe('red');
  });

  test('private status renders the lock indicator only', async () => {
    const r = makeResource({
      canGenerate: false,
      isPrivate: true,
      isOwnedByUser: false,
      model: { id: 1, name: 'M', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    expect(countIcon('lock')).toBe(1);
    expect(countIcon('ban')).toBe(0);
    expect(countIcon('alert-triangle')).toBe(0);
  });

  test('unavailable status renders the ban indicator only', async () => {
    const r = makeResource({
      canGenerate: false,
      isPrivate: false,
      model: { id: 1, name: 'M', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    expect(countIcon('ban')).toBe(1);
    expect(countIcon('lock')).toBe(0);
    expect(countIcon('alert-triangle')).toBe(0);
  });

  test('sfw-only (domain not green) renders the green shield indicator', async () => {
    const r = makeResource({ model: { id: 1, name: 'M', type: 'Checkpoint', sfwOnly: true } });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    expect(countIcon('shield')).toBe(1);
    // compatible + sfw: no warning/lock/ban.
    expect(countIcon('alert-triangle')).toBe(0);
    expect(countIcon('ban')).toBe(0);
  });

  test('minor model (domain not green) ALSO renders the shield (the || operand)', async () => {
    // isSfwOnly = !domain.green && (sfwOnly || minor) — the second operand.
    const r = makeResource({
      model: { id: 1, name: 'M', type: 'Checkpoint', sfwOnly: false, minor: true },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    expect(countIcon('shield')).toBe(1);
  });

  test('green domain SUPPRESSES the shield even when sfwOnly', async () => {
    // The !domain.green guard: on the green domain a sfwOnly resource shows NO
    // shield (green is the SFW-only surface, so the indicator is redundant).
    appContextMock.mockReturnValue({ domain: { green: true, blue: false, red: false } } as any);
    const r = makeResource({ model: { id: 1, name: 'M', type: 'Checkpoint', sfwOnly: true } });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    expect(countIcon('shield')).toBe(0);
  });

  test('showLink (public + not owned): model name is a link', async () => {
    const r = makeResource({
      isPrivate: false,
      isOwnedByUser: false,
      model: { id: 42, name: 'Linked Model', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    const link = page.getByRole('link', { name: 'Linked Model', exact: true });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute('href');
  });

  test('private + not owned: model name is plain text, NO link', async () => {
    const r = makeResource({
      canGenerate: false,
      isPrivate: true,
      isOwnedByUser: false,
      model: { id: 42, name: 'Hidden Model', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('Hidden Model', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: 'Hidden Model', exact: true }))
      .not.toBeInTheDocument();
  });

  test('version-name secondary line shows (name) only when it differs from model name', async () => {
    const r = makeResource({
      name: 'epoch-12',
      model: { id: 1, name: 'My Cool Model', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('(epoch-12)', { exact: true })).toBeInTheDocument();
  });

  test('version-name secondary line absent when name equals model name (case-insensitive)', async () => {
    const r = makeResource({
      name: 'My Cool Model',
      model: { id: 1, name: 'my cool model', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('my cool model', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('(My Cool Model)', { exact: true }))
      .not.toBeInTheDocument();
  });

  test('showLink={false} forces plain text even for a public resource', async () => {
    // The explicit override path: showLink = (showLinkProp ?? true) &&
    // shouldShowModelLink(resource). A public resource would normally link;
    // showLink={false} suppresses it.
    const r = makeResource({
      isPrivate: false,
      isOwnedByUser: false,
      model: { id: 42, name: 'Public Model', type: 'Checkpoint' },
    });
    renderWithProviders(<ResourceItemContent resource={r} showLink={false} />);

    await expect.element(page.getByText('Public Model', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: 'Public Model', exact: true }))
      .not.toBeInTheDocument();
  });

  test('Epoch badge renders when epochDetails.epochNumber is set', async () => {
    const r = makeResource({
      model: { id: 1, name: 'M', type: 'Checkpoint' },
      epochDetails: { jobId: 'j', fileName: 'f', epochNumber: 12, isExpired: false },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('Epoch 12', { exact: true })).toBeInTheDocument();
  });

  test('resource image renders via EdgeMedia2 (image branch)', async () => {
    const r = makeResource({
      model: { id: 1, name: 'M', type: 'Checkpoint' },
      image: { id: 9, url: 'abc-123', type: 'image', width: 100, height: 100, hash: 'h' },
    });
    renderWithProviders(<ResourceItemContent resource={r} />);

    const img = page.getByTestId('edge-media');
    await expect.element(img).toBeInTheDocument();
    await expect.element(img).toHaveAttribute('src', 'abc-123');
  });

  test('strength slider present for LORA + onStrengthChange + enabled; onChange wires back', async () => {
    // Distinct min/max (NOT the -1/2 fallbacks) so the min/max wiring has teeth:
    // a mutation that hardcodes the isSameMinMaxStrength fallback would be caught.
    const r = makeResource({
      minStrength: 0.1,
      maxStrength: 1.5,
      model: { id: 1, name: 'M', type: 'LORA' },
    });
    const onStrengthChange = vi.fn();
    renderWithProviders(
      <ResourceItemContent resource={r} onStrengthChange={onStrengthChange} />
    );

    const slider = page.getByTestId('strength-slider');
    await expect.element(slider).toBeInTheDocument();
    // min/max from resource (not the isSameMinMaxStrength -1/2 fallback).
    await expect.element(slider).toHaveAttribute('data-min', '0.1');
    await expect.element(slider).toHaveAttribute('data-max', '1.5');

    await page.getByTestId('strength-set').click();
    expect(onStrengthChange).toHaveBeenCalledWith(0.5);
  });

  test('strength slider uses the -1/2 fallback when minStrength === maxStrength', async () => {
    // isSameMinMaxStrength branch: equal min/max -> the slider gets the -1/2
    // fallback bounds instead of the (degenerate) resource bounds.
    const r = makeResource({
      minStrength: 1,
      maxStrength: 1,
      model: { id: 1, name: 'M', type: 'LORA' },
    });
    renderWithProviders(<ResourceItemContent resource={r} onStrengthChange={vi.fn()} />);

    const slider = page.getByTestId('strength-slider');
    await expect.element(slider).toBeInTheDocument();
    await expect.element(slider).toHaveAttribute('data-min', '-1');
    await expect.element(slider).toHaveAttribute('data-max', '2');
  });

  test('strength slider passes the disabled prop through and uses the value fallback', async () => {
    // disabled pass-through + value = strengthValue ?? resource.strength ?? 1.
    // Here strengthValue is omitted and resource.strength = 0.8 -> 0.8.
    const r = makeResource({ strength: 0.8, model: { id: 1, name: 'M', type: 'LORA' } });
    renderWithProviders(
      <ResourceItemContent resource={r} onStrengthChange={vi.fn()} disabled />
    );

    const slider = page.getByTestId('strength-slider');
    await expect.element(slider).toBeInTheDocument();
    await expect.element(slider).toHaveAttribute('data-disabled', 'true');
    await expect.element(slider).toHaveAttribute('data-value', '0.8');
  });

  test('strength slider prefers strengthValue over resource.strength', async () => {
    // strengthValue (user-edited) wins the ?? chain over resource.strength.
    const r = makeResource({ strength: 0.8, model: { id: 1, name: 'M', type: 'LORA' } });
    renderWithProviders(
      <ResourceItemContent resource={r} strengthValue={0.3} onStrengthChange={vi.fn()} />
    );

    const slider = page.getByTestId('strength-slider');
    await expect.element(slider).toBeInTheDocument();
    await expect.element(slider).toHaveAttribute('data-value', '0.3');
  });

  test('strength slider ABSENT when showStrength is false', async () => {
    const r = makeResource({ model: { id: 1, name: 'M', type: 'LORA' } });
    renderWithProviders(
      <ResourceItemContent resource={r} onStrengthChange={vi.fn()} showStrength={false} />
    );

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByTestId('strength-slider')).not.toBeInTheDocument();
  });

  test('strength slider ABSENT when no onStrengthChange', async () => {
    const r = makeResource({ model: { id: 1, name: 'M', type: 'LORA' } });
    renderWithProviders(<ResourceItemContent resource={r} />);

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByTestId('strength-slider')).not.toBeInTheDocument();
  });

  test('strength slider ABSENT when type is not LORA/LoCon/DoRA', async () => {
    const r = makeResource({ model: { id: 1, name: 'M', type: 'Checkpoint' } });
    renderWithProviders(
      <ResourceItemContent resource={r} onStrengthChange={vi.fn()} />
    );

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByTestId('strength-slider')).not.toBeInTheDocument();
  });

  test('strength slider ABSENT when status is disabled (incompatible)', async () => {
    const r = makeResource({ baseModel: 'SD1', model: { id: 1, name: 'M', type: 'LORA' } });
    const options: ResourceSelectOptions = {
      resources: [{ type: 'LORA', baseModels: ['SDXL'] }], // SD1 not listed -> incompatible
    };
    renderWithProviders(
      <ResourceItemContent resource={r} options={options} onStrengthChange={vi.fn()} />
    );

    await expect.element(page.getByText('M', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByTestId('strength-slider')).not.toBeInTheDocument();
  });
});
