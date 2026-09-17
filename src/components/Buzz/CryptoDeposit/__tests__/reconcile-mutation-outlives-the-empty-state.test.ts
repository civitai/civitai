import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// If you are here because this test is in your way: the reconcile mutation must be
// created ONCE, by DepositHistory, and never from inside a branch.
//
// DepositHistory renders the notice from two branches — the empty-state one and the
// populated one. A successful reconcile invalidates getDepositHistory, the list stops
// being empty, and the empty-state branch unmounts. A mutation created inside that
// branch unmounts with it, so `Found N deposit(s)!` is destroyed in the same tick it
// is produced and the user is shown an idle `Check now` instead — on exactly the flow
// the control exists for. See ClickUp 868m6j63r; the control shipped in #4918.
//
// That is why the prop is drilled into EmptyDepositState rather than the branch calling
// the hook itself, which is the tidy-up that looks obviously right and silently restores
// the bug. This guard pins the shape, not the behaviour: it cannot observe the state
// surviving the unmount, so do not read it as coverage of that.

const SOURCE = readFileSync(path.join(__dirname, '..', 'DepositHistory.tsx'), 'utf-8');

function bodyOf(declaration: string) {
  const start = SOURCE.indexOf(declaration);
  if (start === -1)
    throw new Error(
      `${declaration} not found. This guard pins where the reconcile mutation is created; ` +
        `read the header comment before renaming past it.`
    );
  const next = SOURCE.indexOf('\nfunction ', start + declaration.length);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next);
}

function occurrences(needle: string) {
  return SOURCE.split(needle).length - 1;
}

describe('reconcile mutation ownership', () => {
  it('is created in the hook, never in the notice', () => {
    expect(bodyOf('function CheckDepositsNotice(')).not.toContain(
      'reconcileMyDeposits.useMutation'
    );
    expect(bodyOf('function useReconcileDeposits(')).toContain('reconcileMyDeposits.useMutation');
  });

  // Counting `.useMutation` would be vacuous: extracting the hook made that one
  // occurrence by construction, so a branch calling the hook itself still counts 1.
  // Count the INVOCATIONS instead — the declaration plus DepositHistory's single call.
  it('is invoked exactly once, and only from the component that spans both branches', () => {
    expect(occurrences('useReconcileDeposits(')).toBe(2);
    expect(bodyOf('export function DepositHistory(')).toContain('useReconcileDeposits(');
    expect(bodyOf('function EmptyDepositState(')).not.toContain('useReconcileDeposits(');
    expect(bodyOf('function CheckDepositsNotice(')).not.toContain('useReconcileDeposits(');
  });
});
