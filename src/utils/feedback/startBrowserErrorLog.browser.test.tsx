// 🔴 THE IMPORT IS THE SUBJECT OF THIS FILE, NOT A DEPENDENCY OF IT. `_app.tsx` makes exactly this
// side-effect import; everything below asks whether making it is enough to start recording.
import '~/utils/feedback/startBrowserErrorLog';

import { expect, test } from 'vitest';
import { readConsoleErrors } from '~/utils/feedback/browserErrorLog';

/**
 * WHEN the console patch is installed — the property the effect-based version got wrong.
 *
 * 🔴 THE RECORDER USED TO INSTALL IN A `useEffect`, WHICH MISSES THE CASE IT EXISTS FOR. A passive
 * effect is flushed AFTER the commit that hydrates the tree, so every `console.error` React emits
 * while hydrating — a hydration mismatch above all, which both `browserErrorLog.ts` and the
 * recorder's own comment name as the motivating case — arrived before the wrapper existed. The
 * network half is retroactive by construction (`observe({ buffered: true })` replays the
 * resource-timing buffer); `console.error` has no such buffer, so a line emitted before the patch
 * is gone for good and "install earlier" is the only available fix.
 *
 * 🔴 THE MEASUREMENT HAS TO HAPPEN AT MODULE SCOPE, AND THAT IS WHY IT LOOKS ODD. A test body runs
 * long after this file's imports have been evaluated, so an assertion made there cannot tell an
 * import-time install from a `beforeEach`-time one. The two lines below run DURING this file's
 * evaluation — after the side-effect import above and before any test, any render, any effect
 * flush — which is the closest a test file gets to "a console.error emitted while the page is still
 * booting". With the install back in a `useEffect`, `capturedAtImport` is empty: nothing has
 * rendered, so no effect has run.
 */
const SENTINEL = 'civitai-feedback-install-timing-probe';
console.error(SENTINEL);
const capturedAtImport = readConsoleErrors().map((entry) => entry.message);

test('importing the module is what installs the console patch', () => {
  expect(capturedAtImport).toContain(SENTINEL);
});

/**
 * The control. Without it, an implementation that seeded the buffer with something — or a
 * `toContain` reading a stale buffer from another file — would pass above while capturing nothing
 * real. A string that was never logged must not be there.
 */
test('a message that was never logged is not in the buffer', () => {
  expect(capturedAtImport).not.toContain(`${SENTINEL}-never-logged`);
});

/**
 * And the patch is still live afterwards, rather than a one-shot that fired during evaluation.
 * A `console.error` from inside a test body is the ordinary case the feature serves.
 */
test('the patch keeps recording after the module has finished evaluating', () => {
  const later = `${SENTINEL}-after-evaluation`;
  console.error(later);

  expect(readConsoleErrors().map((entry) => entry.message)).toContain(later);
});
