/**
 * The `block.manifest.json` the App Blocks preview e2e specs submit
 * (`preview-apps-publish.spec.ts`, `preview-apps-review-flow.spec.ts`).
 *
 * One builder for both specs, so the shape cannot drift between them. It is pure (no Playwright
 * import) so a unit test can pin it: `src/server/services/blocks/__tests__/
 * preview-app-block-manifest.pipeline-drift.test.ts`.
 *
 * A submission is accepted at submit (the approve-time validator runs there) and then BUILT by the
 * App Blocks build pipeline as a review preview. The build runs its own manifest check, so this
 * manifest has to pass both. It deliberately carries ONLY what the platform contract requires,
 * so the smoke also proves that a minimal valid manifest builds:
 *  - no `iframe.src` (server-owned; the platform stamps it),
 *  - no `minApiVersion` (optional and informational in `public/schemas/app-block/v1.json`).
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
  };
}
