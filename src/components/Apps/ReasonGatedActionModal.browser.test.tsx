import { NumberInput } from '@mantine/core';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  ReasonGatedActionModal,
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonGateTooltip,
  reasonMeetsMin,
} from './ReasonGatedActionModal';

/**
 * The shared reason-gated primitives (B3) that back EVERY App Blocks moderator
 * reason-required action. Browser-mode (report-only in Tekton): the live counter +
 * the inline too-short error at the floor boundary; the disabled-with-Tooltip submit;
 * and the full modal's typed-slug (purge) + extra-input (claim) gates.
 */

describe('reasonMeetsMin', () => {
  test('floors on the trimmed length', () => {
    expect(reasonMeetsMin('')).toBe(false);
    expect(reasonMeetsMin('ab')).toBe(false);
    expect(reasonMeetsMin('  a  ')).toBe(false); // trimmed → 1 char
    expect(reasonMeetsMin('abc')).toBe(true);
    expect(reasonMeetsMin('ab', 2)).toBe(true);
  });
});

function FieldHarness({ required = true }: { required?: boolean }) {
  const [v, setV] = useState('');
  return <ReasonGatedField value={v} onChange={setV} required={required} testId="rg-field" />;
}

describe('ReasonGatedField — counter + inline error at the floor boundary', () => {
  test('empty → neutral counter, no error; under floor → counter + error; at floor → error clears', async () => {
    renderWithProviders(<FieldHarness />);
    await expect.element(page.getByText('0/3 characters minimum')).toBeInTheDocument();
    // Empty is neutral (no red error yet).
    expect(page.getByText('Enter at least 3 characters.').elements()).toHaveLength(0);

    await page.getByTestId('rg-field').fill('ab');
    await expect.element(page.getByText('2/3 characters minimum')).toBeInTheDocument();
    await expect.element(page.getByText('Enter at least 3 characters.')).toBeInTheDocument();

    await page.getByTestId('rg-field').fill('abc');
    await expect.element(page.getByText('3/3 characters minimum')).toBeInTheDocument();
    expect(page.getByText('Enter at least 3 characters.').elements()).toHaveLength(0);
  });

  test('an OPTIONAL note has no counter/floor/error', async () => {
    renderWithProviders(<FieldHarness required={false} />);
    await expect.element(page.getByTestId('rg-field')).toBeInTheDocument();
    expect(page.getByText('0/3 characters minimum').elements()).toHaveLength(0);
    await page.getByTestId('rg-field').fill('x');
    expect(page.getByText('Enter at least 3 characters.').elements()).toHaveLength(0);
  });
});

describe('ReasonGatedSubmitButton — disabled-with-Tooltip', () => {
  test('closed gate → disabled + the hint surfaces on hover', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <ReasonGatedSubmitButton onClick={onClick} gateOpen={false} label="Go" testId="rg-submit" />
    );
    const btn = page.getByTestId('rg-submit');
    await expect.element(btn).toBeDisabled();
    await btn.hover();
    await expect.element(page.getByText(reasonGateTooltip())).toBeInTheDocument();
  });

  test('open gate → enabled + fires', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <ReasonGatedSubmitButton onClick={onClick} gateOpen label="Go" testId="rg-submit2" />
    );
    const btn = page.getByTestId('rg-submit2');
    await expect.element(btn).toBeEnabled();
    await btn.click();
    expect(onClick).toHaveBeenCalled();
  });
});

function PurgeHarness({ onSubmit }: { onSubmit: () => void }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  return (
    <ReasonGatedActionModal
      opened
      onCancel={vi.fn()}
      title="Purge — my-slug"
      reason={reason}
      onReasonChange={setReason}
      reasonTestId="rg-modal-reason"
      destructive
      confirmSlug="my-slug"
      confirmValue={confirm}
      onConfirmChange={setConfirm}
      confirmTestId="rg-modal-purge"
      submitLabel="Purge permanently"
      submitTestId="rg-modal-confirm"
      onSubmit={onSubmit}
    />
  );
}

function ClaimHarness({ onSubmit }: { onSubmit: () => void }) {
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<number | ''>('');
  const valid = typeof target === 'number' && target > 0;
  return (
    <ReasonGatedActionModal
      opened
      onCancel={vi.fn()}
      title="Claim — my-slug"
      reason={reason}
      onReasonChange={setReason}
      reasonTestId="rg-modal-reason"
      extraSlot={
        <NumberInput
          label="New owner user id"
          value={target}
          onChange={(v) => setTarget(typeof v === 'number' ? v : '')}
          data-testid="rg-modal-target"
        />
      }
      extraGateSatisfied={valid}
      extraGateTooltip="Enter a valid new owner id."
      submitLabel="Claim"
      submitTestId="rg-modal-confirm"
      onSubmit={onSubmit}
    />
  );
}

describe('ReasonGatedActionModal — composed gates', () => {
  test('purge needs BOTH the reason floor AND the exact typed slug', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PurgeHarness onSubmit={onSubmit} />);
    const confirm = page.getByTestId('rg-modal-confirm');
    await expect.element(confirm).toBeDisabled();

    // Reason alone is not enough.
    await page.getByTestId('rg-modal-reason').fill('malware');
    await expect.element(confirm).toBeDisabled();
    // Hover explains the remaining (typed-slug) gate.
    await confirm.hover();
    await expect.element(page.getByText('Type the slug to confirm.')).toBeInTheDocument();

    // A wrong slug keeps it disabled.
    await page.getByTestId('rg-modal-purge').fill('nope');
    await expect.element(confirm).toBeDisabled();

    // The exact slug enables it → fires.
    await page.getByTestId('rg-modal-purge').fill('my-slug');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(onSubmit).toHaveBeenCalled();
  });

  test('claim needs BOTH the reason floor AND a valid target (extra gate)', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<ClaimHarness onSubmit={onSubmit} />);
    const confirm = page.getByTestId('rg-modal-confirm');
    await expect.element(confirm).toBeDisabled();

    await page.getByTestId('rg-modal-reason').fill('verified owner');
    // Reason met but target invalid → still disabled; hover explains the extra gate.
    await expect.element(confirm).toBeDisabled();
    await confirm.hover();
    await expect.element(page.getByText('Enter a valid new owner id.')).toBeInTheDocument();

    await page.getByTestId('rg-modal-target').fill('555');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(onSubmit).toHaveBeenCalled();
  });
});
