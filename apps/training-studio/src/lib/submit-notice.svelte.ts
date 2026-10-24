import { browser } from '$lib/host';

// A partly-started batch navigates to My trainings (so the charged runs are never re-submitted), which
// unmounts the Review step that would otherwise show why the rest did not start. This carries that
// message across the navigation. Module-scope `$state`: set in the browser only, never during SSR, so
// one user's notice cannot render for another.
let message = $state('');

export const submitNotice = {
  get message(): string {
    return message;
  },
  set(next: string) {
    if (browser) message = next;
  },
  clear() {
    message = '';
  },
};
