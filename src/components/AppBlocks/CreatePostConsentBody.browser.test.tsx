import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

import { CreatePostConsentBody } from './CreatePostConsentBody';
import { buildCreatePostConsentCopy, type CreatePostPreview } from './createPostFromAppGate';

/**
 * 🔴 THE CONSENT SCREEN, RENDERED. This suite is the answer to "a sandboxed block
 * must not be able to show one thing and publish another" — and the only way to
 * answer it is to render the dialog body from a server preview and assert that
 * what appears on screen IS that preview.
 *
 * Each case therefore uses a payload whose values are DISTINCT from one another
 * and from anything the component could plausibly hardcode: a title that is not
 * the detail, tags that are not the dropped tags, a model name that is not the
 * version name. A fixture reusing one string across fields cannot tell "renders
 * the title" from "renders the detail in the title's place".
 */

function preview(over: Partial<CreatePostPreview> = {}): CreatePostPreview {
  return {
    title: 'Aurora Study 04',
    detail: 'Three renders from one seed, tuned for the cold palette.',
    tags: ['landscape', 'concept-art'],
    droppedTags: [],
    images: [
      { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', width: 512, height: 512 },
      { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACw=', width: 512, height: 512 },
    ],
    gallery: null,
    ...over,
  };
}

async function render(p: CreatePostPreview, appName = 'Benchmarker') {
  const copy = buildCreatePostConsentCopy({ appName, preview: p });
  renderWithProviders(<CreatePostConsentBody copy={copy} preview={p} />);
  // 🔴 AWAIT THE ROOT BEFORE ANY SYNCHRONOUS `.element()` READ. `render` returns
  // before React has committed, so a bare `page.getByTestId(...).element()`
  // throws "Cannot find element" — which reads as "the component does not render
  // that" rather than "you read too early". Measured: four cases failed that way,
  // and the three that happened to use the retrying `expect.element` passed, so
  // the file looked half-broken instead of uniformly early.
  await expect.element(page.getByTestId('block-create-post-consent')).toBeInTheDocument();
  return copy;
}

/** The committed root, for the synchronous DOM reads (absence assertions). */
function root() {
  return page.getByTestId('block-create-post-consent').element();
}

describe('CreatePostConsentBody — the rendered confirm reflects the SERVER payload', () => {
  test('renders the exact title and detail the server resolved', async () => {
    const p = preview();
    await render(p);

    await expect
      .element(page.getByTestId('block-create-post-title'))
      .toHaveTextContent('Aurora Study 04');
    await expect
      .element(page.getByTestId('block-create-post-detail'))
      .toHaveTextContent('Three renders from one seed, tuned for the cold palette.');
  });

  test('renders ONE thumbnail per resolved image, from the server-resolved urls', async () => {
    const p = preview();
    await render(p);

    const thumbs = page.getByTestId('block-create-post-thumbs').element().querySelectorAll('img');
    // A COUNT-only confirm (what the existing publish dialog shows) cannot
    // distinguish these two images from two completely different ones.
    expect(thumbs.length).toBe(2);
    expect(Array.from(thumbs).map((i) => i.getAttribute('src'))).toEqual(
      p.images.map((i) => i.url)
    );
  });

  test('renders the RESOLVED tags, not the requested ones, and names the dropped set', async () => {
    const p = preview({
      tags: ['landscape'],
      droppedTags: ['a-tag-that-does-not-exist'],
    });
    await render(p);

    const tags = page.getByTestId('block-create-post-tags');
    await expect.element(tags).toHaveTextContent('landscape');
    // The dropped one must NOT appear as an applied tag…
    expect(tags.element().textContent).not.toContain('a-tag-that-does-not-exist');
    // …but must be disclosed, so a silent discard is visible.
    await expect
      .element(page.getByTestId('block-create-post-dropped-tags'))
      .toHaveTextContent('a-tag-that-does-not-exist');
  });

  test('always states the PUBLIC / your-name destination — the consequence a thumbnail cannot show', async () => {
    await render(preview());
    const dest = page.getByTestId('block-create-post-destination');
    await expect.element(dest).toHaveTextContent('public');
    await expect.element(dest).toHaveTextContent('under your name');
  });

  test('names the host-resolved model AND version when a gallery attach is requested', async () => {
    await render(
      preview({
        gallery: { modelVersionId: 3100, modelName: 'DreamThing', versionName: 'v2.0' },
      })
    );
    const gallery = page.getByTestId('block-create-post-gallery');
    await expect.element(gallery).toHaveTextContent('DreamThing');
    await expect.element(gallery).toHaveTextContent('v2.0');
  });

  test('renders NO gallery line when there is no attach', async () => {
    await render(preview());
    expect(root().querySelector('[data-testid="block-create-post-gallery"]')).toBeNull();
  });

  test('renders NO title/detail rows for an untitled post rather than empty labelled rows', async () => {
    await render(preview({ title: null, detail: null }));
    expect(root().querySelector('[data-testid="block-create-post-title"]')).toBeNull();
    expect(root().querySelector('[data-testid="block-create-post-detail"]')).toBeNull();
    // The destination sentence is NOT conditional — it must survive an otherwise
    // empty post, because it is the part that carries the consequence.
    expect(root().querySelector('[data-testid="block-create-post-destination"]')).not.toBeNull();
  });

  test('block-authored markup renders as TEXT, never as markup, inside host chrome', async () => {
    // A block controls `title`/`detail`. If either were interpolated as HTML the
    // block could paint its own UI inside the host's consent dialog — the exact
    // spoof the dialog exists to prevent.
    const p = preview({
      title: '<img src=x onerror=alert(1)>',
      detail: '<button data-testid="injected">Fake Cancel</button>',
    });
    await render(p);

    expect(root().querySelector('[data-testid="injected"]')).toBeNull();
    expect(root().querySelector('button')).toBeNull();
    await expect
      .element(page.getByTestId('block-create-post-title'))
      .toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});
