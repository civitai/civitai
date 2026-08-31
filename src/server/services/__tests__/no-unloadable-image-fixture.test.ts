import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-unloadable-image-fixture'];

// Same harness shape as no-module-scope-cache.test.ts: RuleTester drives the test
// framework's globals, so `ruleTester.run(...)` must be called at the top level of
// the module (NOT nested inside a vitest `it()`). `parser` is a valid top-level
// RuleTester option in ESLint 8 (eslintrc mode) but @types/eslint's config type
// omits it — build untyped and cast so `tsc --noEmit` stays green.
//
// `ecmaFeatures.jsx` is required here and not in the sibling rule tests: this rule
// inspects JSX attributes, so the invalid/valid cases below contain real JSX.
const ruleTesterConfig: Record<string, unknown> = {
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
};
const ruleTester = new RuleTester(ruleTesterConfig as ConstructorParameters<typeof RuleTester>[0]);

const errors = [{ messageId: 'unloadableImageFixture' }];

ruleTester.run('no-unloadable-image-fixture', rule, {
  valid: [
    // ================================================================
    // The canonical fix — the shared data: URI fixture
    // ================================================================
    `renderWithProviders(<Card card={base({ coverUrl: LOADABLE_IMAGE_DATA_URI })} />);`,
    `const card = { iconUrl: LOADABLE_IMAGE_DATA_URI, coverUrl: LOADABLE_IMAGE_DATA_URI };`,
    // An inline data: URI (not the shared constant) is still loadable.
    `const card = { coverUrl: 'data:image/png;base64,iVBORw0KGg==' };`,
    // A same-origin relative path is deliberately NOT covered — see the rule
    // header. AppBlockCard / AppDetailsModal both use this shape today.
    `const card = { coverUrl: '/api/blocks/screenshot/app-1/0.png' };`,
    `const s = { url: '/api/blocks/screenshot/app-1/1.webp' };`,

    // ================================================================
    // 🔴 The false-positive boundary. Every case below is a REAL shape that
    // exists in src/**/*.browser.test.tsx today and must stay clean; each one
    // is an http(s) URL that cannot become an <img> from a fixture.
    // ================================================================
    // OnsiteReviewModal.browser.test.tsx:37 — an IFRAME document, not an image.
    // This is why the ambiguous `src` key must prove it is an image.
    `const props = { iframe: { src: 'https://example.com/block', sandbox: 'allow-scripts' } };`,
    // …and a bare non-image `src` anywhere else.
    `const cfg = { src: 'https://example.com/some/route' };`,
    `const el = <iframe src="https://example.com/block" />;`,
    `const el = <script src="https://cdn.example.com/analytics" />;`,
    // AgentReviewChat.browser.test.tsx:387 — an http image URL inside a MARKDOWN
    // body. The test's whole point is asserting NO <img> is produced from it
    // (`expect(bubble.querySelector('img')).toBeNull()`), and it is not in an
    // image-source position, so it can never mount a broken <img>.
    "mocks.chatReply = 'Look here: ![tracking](https://example.com/pixel.png)';",
    // AppDetailsModal.browser.test.tsx:127 / CombinedReviewModal:41 /
    // recents-helper:138 — link targets, not image sources.
    `const block = { liveUrl: 'https://my-block.example.com' };`,
    `const req = { reviewRepoUrl: 'https://forgejo.example/repo' };`,
    `const app = { externalUrl: 'https://ext.example/app' };`,
    // OnsiteReviewModal.browser.test.tsx:397 — a block PREVIEW page, not an image.
    `const r = { previewUrl: 'https://my-onsite-block.civit.ai/my-onsite-block?mr=tok' };`,
    // ExternalSubmitForm.browser.test.tsx — a URL typed into a form field.
    `await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');`,
    `async function advanceFromUrl(url = 'https://vitrine.civitai.com') {}`,

    // A non-string literal, and an interpolated template, are both out of scope.
    `const card = { coverUrl: null };`,
    'const card = { coverUrl: `${base}/cover.png` };',
    // A computed key is not a name we can trust.
    `const card = { [key]: 'https://edge/cover.png' };`,
  ],

  invalid: [
    // ================================================================
    // The shape that actually bit us — an unloadable icon behind a Mantine
    // Avatar, asserted with `expect(img).not.toBeNull()` (#3551).
    // ================================================================
    {
      code: `recordRecentlyOpenedApp({ id: 'other', name: 'Other App', iconUrl: 'https://edge/icon.png' });`,
      errors,
    },
    // AppListingCard.browser.test.tsx:442 (fixed in this change) — two on one line.
    {
      code: `const card = base({ iconUrl: 'https://edge/icon.png', coverUrl: 'https://edge/cover.png' });`,
      errors: [...errors, ...errors],
    },
    // AppListingCard.browser.test.tsx:531 — the deliberate error-path fixture.
    // It IS reported; the escape hatch (a disable comment with a reason) is what
    // makes it legal, and that is asserted separately below.
    {
      code: `const card = base({ coverUrl: 'https://edge.invalid/does-not-exist.png' });`,
      errors,
    },
    // The remaining real key spellings in the repo's browser tests.
    {
      code: `const meta = { coverImageUrl: 'https://cdn/og-cover.png', iconImageUrl: 'https://cdn/og-icon.png' };`,
      errors: [...errors, ...errors],
    },
    // http, not just https.
    { code: `const card = { avatarUrl: 'http://cdn.example/a.png' };`, errors },
    // An unambiguous image key does NOT need a file extension — the key alone
    // proves it is an image, so an extensionless CDN URL is still caught.
    { code: `const card = { iconUrl: 'https://cdn.example/icon' };`, errors },

    // ================================================================
    // The ambiguous `src` key — reported only where we can PROVE it is an image
    // ================================================================
    // (a) proven by the file extension …
    { code: `const cfg = { src: 'https://cdn.example/pic.jpeg' };`, errors },
    { code: `const cfg = { src: 'https://cdn.example/pic.webp?v=2' };`, errors },
    // (b) … or by the JSX element being an image component.
    { code: `const el = <img src="https://cdn.example/no-extension" />;`, errors },
    { code: `const el = <Avatar src={'https://cdn.example/no-extension'} />;`, errors },
    { code: `const el = <EdgeMedia src="https://cdn.example/no-extension" />;`, errors },

    // Other binding forms that reach the same hazard.
    { code: `const iconUrl = 'https://edge/icon.png';`, errors },
    { code: `mocks.coverUrl = 'https://edge/cover.png';`, errors },
    { code: 'const card = { coverUrl: `https://edge/cover.png` };', errors },
    { code: `const el = <Card iconUrl="https://edge/icon.png" />;`, errors },
  ],
});
