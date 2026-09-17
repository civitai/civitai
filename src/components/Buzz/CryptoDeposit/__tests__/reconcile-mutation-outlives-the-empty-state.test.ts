import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// If you are here because this test is in your way: the mutation must NOT move back
// into CheckDepositsNotice, however much it looks like it belongs there.
//
// DepositHistory renders the notice from two branches — the empty-state one and the
// populated one. A successful reconcile invalidates getDepositHistory, the list stops
// being empty, and the empty-state branch unmounts. A mutation owned by the notice
// unmounts with it, so `Found N deposit(s)!` is destroyed in the same tick it is
// produced and the user is shown an idle `Check now` instead — on exactly the flow
// the control exists for. See ClickUp 868m6j63r; the original control shipped in #4918.
//
// Keeping the mutation in a hook called by DepositHistory is what makes the
// confirmation survive the branch swap, because DepositHistory itself does not unmount.

const SOURCE = readFileSync(
  path.join(__dirname, '..', 'DepositHistory.tsx'),
  'utf-8'
);

function bodyOf(declaration: string) {
  const start = SOURCE.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} not found — was it renamed?`);
  const next = SOURCE.indexOf('\nfunction ', start + declaration.length);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next);
}

describe('reconcile mutation ownership', () => {
  it('is created outside CheckDepositsNotice, so a success survives the empty-state unmounting', () => {
    expect(bodyOf('function CheckDepositsNotice(')).not.toContain(
      'reconcileMyDeposits.useMutation'
    );
    expect(bodyOf('function useReconcileDeposits(')).toContain(
      'reconcileMyDeposits.useMutation'
    );
  });

  it('has exactly one call site for the mutation', () => {
    const calls = SOURCE.split('reconcileMyDeposits.useMutation').length - 1;
    expect(calls).toBe(1);
  });

  it('is called by DepositHistory, the component that spans both branches', () => {
    expect(bodyOf('export function DepositHistory(')).toContain('useReconcileDeposits()');
  });
});
