import type { SubmitFunction } from '@sveltejs/kit';
import { tick } from 'svelte';

export type ViolationGate = ReturnType<typeof createViolationGate>;

/** The violation type and note a removal on a detail pane posts; it submits only with a type. */
export function createViolationGate() {
  let type = $state('');
  let note = $state('');
  let select = $state<HTMLElement | null>(null);
  let problem = $state<string | null>(null);
  return {
    get type() {
      return type;
    },
    set type(value: string) {
      type = value;
    },
    get note() {
      return note;
    },
    set note(value: string) {
      note = value;
    },
    get select() {
      return select;
    },
    set select(element: HTMLElement | null) {
      select = element;
    },
    /** What the decision bar says went wrong. */
    get problem() {
      return problem;
    },
    set problem(value: string | null) {
      problem = value;
    },
    /** Whether `input` may submit: without a type it is cancelled and the type select focused. */
    async gate(input: Parameters<SubmitFunction>[0]) {
      if (type) {
        problem = null;
        return true;
      }
      input.cancel();
      problem = 'Pick a violation type first.';
      await tick();
      select?.focus();
      return false;
    },
  };
}
