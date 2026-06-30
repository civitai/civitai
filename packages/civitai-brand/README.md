# @civitai/brand

Framework-agnostic Civitai brand marks — raw SVG path geometry, gradient palettes, and ready-made
SVG-string builders. No React, no DOM, no runtime dependencies, browser-safe.

## Add to an app

```jsonc
// package.json
"@civitai/brand": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/brand']`, Vite `ssr.noExternal: ['@civitai/brand']`.
Zero dependencies.

## Env

None.

## Exports

| Import | Gives you |
|---|---|
| `@civitai/brand` | `buildWordmarkSvg`, `buildBadgeSvg`, `buildFaviconSvg`, `WORDMARK`/`BADGE` paths, `GRADIENTS`, `getHoliday` |
| `@civitai/brand/paths` | raw `<path>` geometry (render natively, theme via CSS) |
| `@civitai/brand/gradients`, `/holiday`, `/svg` | focused subsets |

## Use

```ts
import { buildWordmarkSvg, buildFaviconSvg } from '@civitai/brand';

const wordmark = buildWordmarkSvg({ base: '#e8eaed' }); // inject via {@html} / dangerouslySetInnerHTML
```

Serve the favicon from a single source — prerender `buildFaviconSvg()` at a `favicon.svg` route rather
than committing a static asset.

## Gotchas

- The builders return **SVG strings** for `{@html}`/`dangerouslySetInnerHTML`; use `/paths` if you'd
  rather render `<path>` elements natively and theme with CSS.

Reference: [apps/moderator/src/routes/favicon.svg/+server.ts](../../apps/moderator/src/routes/favicon.svg/+server.ts).
