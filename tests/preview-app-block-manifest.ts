/**
 * The `block.manifest.json` the App Blocks preview e2e specs submit
 * (`preview-apps-publish.spec.ts`, `preview-apps-review-flow.spec.ts`).
 *
 * One builder for both specs, so the shape cannot drift between them. It is pure (no Playwright
 * import) so a unit test can pin it: `src/server/services/blocks/__tests__/
 * preview-app-block-manifest.pipeline-drift.test.ts`.
 *
 * A submission can also be BUILT as an automatic review preview, and that build runs its own
 * manifest check, so this manifest must pass both. It deliberately carries ONLY what the platform
 * contract requires, so the smoke also proves that a minimal valid manifest builds:
 *  - no `iframe.src` (server-owned; the platform stamps it),
 *  - no `minApiVersion` (optional and informational in `public/schemas/app-block/v1.json`).
 * It does declare a surface (a `page`): the build refuses a manifest with neither a non-empty
 * `targets[]` nor a `page{}`, and a real app always has one.
 */
export function previewAppBlockManifest(args: { slug: string; name: string }) {
  return {
    blockId: args.slug,
    version: '0.1.0',
    name: args.name,
    contentRating: 'g',
    scopes: [] as string[],
    iframe: {
      minHeight: 300,
      maxHeight: null,
      resizable: true,
      sandbox: 'allow-scripts allow-forms',
    },
    page: { path: '/', title: args.name },
  };
}
