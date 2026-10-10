/**
 * The post-detail "Published with <app>" chip, in real Chromium.
 *
 * Three things are pinned here and nowhere else:
 *
 *  1. 🔴 THE WORDING, as a WHOLE NORMALISED STRING. `public-owner.ts` exists
 *     because the app page once rendered `by {appName}` and — since an approved
 *     block's `OauthClient.name` equals the app's own title — the AUTHOR slot
 *     showed the APP TITLE. This chip sits in the post header beside real author
 *     attribution, so a reword back toward "by" is the regression that matters.
 *     Asserting the whole sentence rather than a substring is what makes a
 *     reword fail: a `toContain('Published with')` check passes happily on
 *     "Published with Gen Matrix by Gen Matrix".
 *  2. The LINKED vs UNLINKED branches, which are a disclosure decision — a
 *     not-viewable app must not get a `/apps/store-preview/<slug>` link the
 *     destination refuses to serve.
 *  3. That a null chip renders NOTHING, and that a missing icon renders no
 *     placeholder box.
 *
 * 🔴 EVERY DOM READ IS GATED ON AN AWAITED LOCATOR FIRST. React 18's
 * `createRoot().render()` commits asynchronously, so a synchronous
 * `document.querySelector` straight after `renderWithProviders` reads an EMPTY
 * container — which looks exactly like a component that returned null. That cost
 * a round here: five tests failed reporting an absent chip against a component
 * that renders it correctly.
 *
 * The same hazard makes a bare "renders nothing" assertion VACUOUS — an empty
 * container satisfies it whether or not the render ever happened. So the two
 * negative tests render a sibling marker and wait for THAT before concluding the
 * chip is absent. The marker is the positive control for the zero.
 */
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { PostPublishedWithApp } from '~/components/Post/Detail/PostPublishedWithApp';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip.logic';

const CHIP = '[data-testid="post-published-with-app"]';

const chip = () => document.querySelector<HTMLElement>(CHIP);

/**
 * The rendered sentence, whitespace-normalised.
 *
 * NBSP and the JSX `{' '}` separators are not the assertion's subject, so they
 * are collapsed — but nothing else is, so an extra word cannot hide in here.
 */
const sentence = () => (chip()?.textContent ?? '').replace(/\s+/gu, ' ').trim();

/** Wait for the chip to be committed, then hand back the normalised sentence. */
async function renderedSentence(app: PostAppChip) {
  renderWithProviders(<PostPublishedWithApp app={app} />);
  await expect.element(page.getByTestId('post-published-with-app')).toBeInTheDocument();
  return sentence();
}

/** Render with a sibling marker so "the chip is absent" can be distinguished
 *  from "nothing has rendered yet". */
async function renderedWithoutChip(app: PostAppChip | null | undefined) {
  renderWithProviders(
    <>
      <div data-testid="render-committed" />
      <PostPublishedWithApp app={app} />
    </>
  );
  await expect.element(page.getByTestId('render-committed')).toBeInTheDocument();
}

const viewable: PostAppChip = {
  slug: 'custom-generators',
  name: 'Custom Generators',
  iconUrl: LOADABLE_IMAGE_DATA_URI,
};

describe('PostPublishedWithApp', () => {
  // `null` covers three production states that are indistinguishable here and
  // should be: no marker, a marker that resolves to nothing, and a viewer
  // without store visibility. `undefined` covers a client that has not received
  // the field at all (a cached payload from before this change).
  //
  // Two tests rather than two renders in one: a second `render` in the same test
  // runs before the auto-`cleanup()` and leaves vitest-browser-react holding a
  // stale root — which surfaces as an unhandled rejection inside its own
  // `render` and then as EVERY LATER TEST IN THE FILE rendering empty. The
  // failure does not name the test that caused it, so it reads as the component
  // being broken.
  test('renders nothing at all when the server resolved no app', async () => {
    await renderedWithoutChip(null);
    expect(chip()).toBeNull();
  });

  test('renders nothing when the field is absent entirely', async () => {
    await renderedWithoutChip(undefined);
    expect(chip()).toBeNull();
  });

  test('reads exactly "Published with <app name>" — never "by"', async () => {
    // 🔴 The whole string. Reword the sentence and this fails; that is the cost
    // of the guard and it is deliberate.
    expect(await renderedSentence(viewable)).toBe('Published with Custom Generators');
    expect(sentence()).not.toMatch(/\bby\b/iu);
  });

  test('links a viewable app to its store detail, with the slug encoded', async () => {
    await renderedSentence({ ...viewable, slug: 'needs encoding/../x' });
    const anchor = chip()?.querySelector('a');
    expect(anchor).not.toBeNull();
    // Encoded, because the destination is built by concatenation: a `../`, a
    // `//host`, or a `?`/`#` in a slug would otherwise steer the path off
    // `/apps/store-preview/`.
    expect(anchor?.getAttribute('href')).toBe('/apps/store-preview/needs%20encoding%2F..%2Fx');
  });

  test('renders the name UNLINKED when the app is not publicly viewable', async () => {
    // The live instance of this branch: an app whose block is suspended and
    // whose listing is removed. `/apps/store-preview/<slug>` refuses to serve
    // it, so a link here would be a 404 dressed as a working link.
    expect(await renderedSentence({ slug: null, name: 'Ab Img Poster', iconUrl: null })).toBe(
      'Published with Ab Img Poster'
    );
    expect(chip()?.querySelector('a')).toBeNull();
    // Nothing on the page may carry a store-preview href for this app.
    expect(document.querySelector('a[href*="store-preview"]')).toBeNull();
  });

  test('renders a decorative icon when there is one', async () => {
    await renderedSentence(viewable);
    const icon = chip()?.querySelector('img');
    expect(icon).not.toBeNull();
    // Decorative: the sentence beside it already names the app, so an accessible
    // name here would make a screen reader announce it twice.
    expect(icon?.getAttribute('alt')).toBe('');
  });

  test('renders cleanly for an app with no icon — the common live case', async () => {
    expect(await renderedSentence({ ...viewable, iconUrl: null })).toBe(
      'Published with Custom Generators'
    );
    // Mantine's `Avatar` draws a grey placeholder box when `src` is absent, which
    // reads as a broken image. The component omits it entirely instead.
    expect(chip()?.querySelector('img')).toBeNull();
    expect(chip()?.querySelector('.mantine-Avatar-root')).toBeNull();
  });
});
