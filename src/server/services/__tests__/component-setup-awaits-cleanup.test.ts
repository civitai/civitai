import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — `test/component-setup.tsx`'s `afterEach` MUST await `cleanup()`.
 *
 * WHY THIS EXISTS
 * `cleanup()` from vitest-browser-react 2.2.0 is `async` (dist/pure-*.js:112).
 * Per mounted root it does `await act(async () => root.unmount())` and only THEN
 * `document.body.removeChild(container)` — so the container is detached in a
 * LATER microtask, not synchronously.
 *
 * The hook used to read:
 *
 *     afterEach(() => {
 *       cleanup();
 *     });
 *
 * A block body with no `return`, so the promise floated: Vitest received
 * `undefined` and did not wait. Container removal then raced the NEXT test's
 * render, and two mounted containers could sit in `document.body` at once.
 * `page.getByTestId(...)` is DOCUMENT-scoped, so a testid rendered exactly once
 * per mount resolved to 2 elements and failed with a strict-mode violation.
 *
 * That is the long-running `AppListingDetailBody > the "Browse all apps" link is
 * present even when the rail is empty` flake — `apps-browse-all` is rendered in
 * exactly ONE place (`src/components/Apps/RelatedListings.tsx`), so a duplicate
 * could only come from a leaked container. Observed red on loaded CI pods and
 * green on quiet ones, moving between container indices.
 *
 * WHY A SOURCE GATE RATHER THAN A BEHAVIOURAL TEST
 * The defect is a RACE. Reproducing it on demand needs a machine slow enough for
 * the microtask not to drain between tests, so a behavioural test would be
 * exactly the kind of load-dependent assertion this gate exists to eliminate —
 * green on a fast runner while the bug is fully present. Reading the hook shape
 * is deterministic and cannot flake.
 *
 * 🔴 SCOPE, honestly: this gate proves the promise is not DROPPED. It does not
 * prove Vitest awaits hook return values (it does) nor that cleanup is the only
 * source of container leaks. It catches the specific regression that happened.
 */
describe('🔴 test/component-setup.tsx awaits cleanup()', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../../../test/component-setup.tsx'),
    'utf8'
  );

  // Strip comments first: the docblock above the hook quotes the OLD broken form
  // verbatim, so an unstripped match would find the counter-example in prose and
  // report a false failure. Same reason the sibling no-raw-iframe gate strips.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const code = stripComments(source);

  it('positive control — the stripper leaves real code intact and removes comments', () => {
    // Without this, a stripper that returned '' would make every assertion below
    // vacuously green.
    expect(stripComments('const a = 1;')).toContain('const a = 1;');
    expect(stripComments('/* cleanup(); */ const b = 2;')).not.toContain('cleanup();');
    expect(code).toContain('export function renderWithProviders');
  });

  it('the afterEach hook awaits cleanup()', () => {
    const hook = code.match(/afterEach\(([\s\S]*?)\n\}\);/);
    expect(hook, 'no afterEach hook found in component-setup.tsx').not.toBeNull();
    const body = hook![0];

    // Either `async () => { await cleanup(); }` or a returned promise.
    const awaits = /await\s+cleanup\s*\(/.test(body);
    const returns = /=>\s*cleanup\s*\(/.test(body) || /return\s+cleanup\s*\(/.test(body);

    expect(
      awaits || returns,
      'afterEach must AWAIT or RETURN cleanup() — vitest-browser-react cleanup() is ' +
        'async and detaches the container after an await. Dropping the promise lets ' +
        'container removal race the next test, leaving two mounted containers in ' +
        'document.body and breaking document-scoped getByTestId queries.'
    ).toBe(true);
  });

  it('cleanup() is never called as a bare, unawaited statement', () => {
    // The exact regression shape: `cleanup();` on its own line with nothing
    // awaiting or returning it.
    const bare = code.split('\n').filter((l) => /^\s*cleanup\s*\(\s*\)\s*;\s*$/.test(l));
    expect(bare, `bare unawaited cleanup() call(s): ${JSON.stringify(bare)}`).toEqual([]);
  });
});
