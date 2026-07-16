import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { z } from 'zod';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { Form, InputNumber, useForm } from '~/libs/form';

/**
 * Repro for tester feedback: clearing an InputNumber (select-all + delete / backspace to empty)
 * must leave the field visibly empty — not re-render the previous value (RHF's useController
 * substitutes the field's defaultValue when the stored value is undefined). Mirrors the Entry
 * Fee setup: min/max/step + a form.watch that re-renders the whole form on every keystroke
 * (like `entryFeeWatch` in ChallengeUpsertForm). Both clampBehavior modes are covered — the
 * production prize inputs use "blur"; "none" pins the mode PR #3176 shipped with.
 */

const schema = z.object({
  amount: z.number().int().min(50).max(100_000).default(50),
});

function Harness({ clampBehavior }: { clampBehavior: 'blur' | 'none' }) {
  const form = useForm({ schema, defaultValues: { amount: 500 } });
  // Same shape as ChallengeUpsertForm's `entryFeeWatch` — forces a parent re-render per keystroke.
  const watched = form.watch('amount') ?? 50;

  return (
    <Form form={form}>
      <InputNumber
        name="amount"
        label="Amount"
        min={50}
        max={100_000}
        step={10}
        allowNegative={false}
        clampBehavior={clampBehavior}
      />
      <div data-testid="watched">{String(watched)}</div>
    </Form>
  );
}

describe.each(['blur', 'none'] as const)('InputNumber — clearing the value (clampBehavior=%s)', (clampBehavior) => {
  test('select-all + delete leaves the field empty, and it stays empty on blur', async () => {
    renderWithProviders(<Harness clampBehavior={clampBehavior} />);

    const input = page.getByLabelText('Amount');
    await expect.element(input).toHaveValue('500');

    await input.clear();
    await expect.element(input).toHaveValue('');

    // Blur — the emptied field must not resurrect the old value (or blur-clamp it back in).
    await page.getByTestId('watched').click();
    await expect.element(input).toHaveValue('');
  });

  test('backspacing digit by digit down to empty leaves the field empty', async () => {
    renderWithProviders(<Harness clampBehavior={clampBehavior} />);

    const input = page.getByLabelText('Amount');
    await input.click();
    await input.fill('500');
    await expect.element(input).toHaveValue('500');

    // Erase one character at a time like a user on mobile would.
    await userEvent.keyboard('{End}');
    await userEvent.keyboard('{Backspace}');
    await expect.element(input).toHaveValue('50');
    await userEvent.keyboard('{Backspace}');
    await expect.element(input).toHaveValue('5');
    await userEvent.keyboard('{Backspace}');
    await expect.element(input).toHaveValue('');
  });
});
