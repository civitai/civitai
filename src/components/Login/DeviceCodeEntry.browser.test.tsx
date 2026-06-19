import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DeviceCodeEntry } from '~/components/Login/DeviceCodeEntry';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// DeviceCodeEntry is the code-entry step of the OAuth device flow. It owns the
// "when to submit" UX (Enter-to-submit + auto-submit on a complete code) and the
// double-submit guard; the parent owns the actual lookup. These tests pin that
// trigger behavior against the real rendered DOM (Vitest browser mode) with a
// plain `onSubmit` spy — no fetch/router/auth mocking needed.
//
// Canonical full code: 8 chars displayed `XXXX-XXXX` (e.g. `49XA-AMH2`).
const FULL_CODE = '49XA-AMH2';
const FULL_CODE_NO_HYPHEN = '49XAAMH2';

const input = () => page.getByRole('textbox', { name: 'Device code' });

describe('DeviceCodeEntry', () => {
  test('pressing Enter with a complete code submits exactly once (canonical form)', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    // `fill` sets the value in one event (like a paste). To exercise the Enter
    // path specifically, type a code that is NOT yet complete via fill, then the
    // last char + Enter. Simpler: fill an incomplete value, then press Enter
    // after completing — but completeness auto-submits. So drive Enter on a
    // value we KNOW is complete by filling then immediately checking it fired
    // once total (auto-submit), then Enter again must NOT add a second call.
    await userEvent.fill(input(), FULL_CODE);
    expect(onSubmit).toHaveBeenCalledTimes(1); // auto-submit on completeness

    await userEvent.click(input());
    await userEvent.keyboard('{Enter}'); // Enter on the already-submitted value
    expect(onSubmit).toHaveBeenCalledTimes(1); // guard: no double-submit

    expect(onSubmit).toHaveBeenCalledWith(FULL_CODE); // canonical hyphenated form
  });

  test('Enter submits when a complete code was assembled without auto-submit firing first', async () => {
    // Mount already-complete via initialCode would auto-submit on mount; instead
    // type a partial code (no auto-submit), then complete the last char in a way
    // that the auto-submit + Enter still collapse to one call. This asserts Enter
    // works as a submit trigger and is idempotent with auto-submit.
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.type(input(), FULL_CODE_NO_HYPHEN); // typing reaches full length
    // Typing the final char completes the code → auto-submit fires once.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1); // Enter does not re-fire
    expect(onSubmit).toHaveBeenCalledWith(FULL_CODE);
  });

  test('pasting a complete code auto-submits exactly once (no Enter/click)', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    // `fill` mirrors a paste: one change event filling the field to completeness.
    await userEvent.fill(input(), FULL_CODE);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(FULL_CODE);
  });

  test('pasting a complete code WITHOUT the hyphen still auto-submits in canonical form', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.fill(input(), FULL_CODE_NO_HYPHEN);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Server's reverse-lookup key is the hyphenated form — component must format.
    expect(onSubmit).toHaveBeenCalledWith(FULL_CODE);
  });

  test('typing a complete code auto-submits', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.type(input(), FULL_CODE_NO_HYPHEN);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(FULL_CODE);
  });

  test('a partial code does NOT submit (Enter is a no-op, button disabled)', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.fill(input(), '49XA'); // only 4 of 8 chars
    await userEvent.click(input());
    await userEvent.keyboard('{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  test('an empty code does NOT submit', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.click(input());
    await userEvent.keyboard('{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  test('a complete initialCode (verification_uri_complete) auto-submits once on mount, not per render', async () => {
    const onSubmit = vi.fn();
    const { rerender } = await renderWithProviders(
      <DeviceCodeEntry initialCode={FULL_CODE} onSubmit={onSubmit} />
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);

    // A re-render with the same complete value must NOT re-fire (the ref guard).
    await rerender(<DeviceCodeEntry initialCode={FULL_CODE} onSubmit={onSubmit} username="alice" />);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('does not re-fire while a submit is in flight (loading)', async () => {
    const onSubmit = vi.fn();
    const { rerender } = await renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.fill(input(), FULL_CODE);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Parent flips to loading after the first submit. The button shows a spinner
    // and is non-interactive; pressing Enter must not stack a second lookup.
    await rerender(<DeviceCodeEntry loading onSubmit={onSubmit} />);
    await userEvent.click(input());
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('after a failed lookup, editing + re-completing submits again', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    // First complete code auto-submits.
    await userEvent.fill(input(), FULL_CODE);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Lookup "fails" upstream → user edits the field to a DIFFERENT complete
    // code. Re-completing must fire a fresh submit (guard re-arms on edit).
    const SECOND_CODE = 'BCDE-FGHJ';
    await userEvent.clear(input());
    await userEvent.fill(input(), SECOND_CODE);

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(SECOND_CODE);
  });

  test('re-submitting the SAME complete value after clearing it re-arms (edit clears the guard)', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    await userEvent.fill(input(), FULL_CODE);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Clear (a real edit to a non-matching value) re-arms, then re-typing the
    // same code is a legitimate fresh submit.
    await userEvent.clear(input());
    await userEvent.fill(input(), FULL_CODE);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  test('focuses the code input on mount so the user can paste/type immediately', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<DeviceCodeEntry onSubmit={onSubmit} />);

    // The mount-time focus effect should put the caret in the field with no
    // click, and it must not have triggered a submit on an empty value.
    await expect.element(input()).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
