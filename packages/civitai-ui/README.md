# @civitai/ui

Shared [shadcn-svelte](https://shadcn-svelte.com) components + theme for the monorepo's SvelteKit apps
(`apps/moderator`, future `creator-hub`, …). Built on `bits-ui`, Tailwind v4, Svelte 5. Dark-only.

Components ship **raw** (no build step) like the other `@civitai/*` packages; consumers transpile via Vite
`ssr.noExternal`. Internal imports use the `@civitai/ui` self-alias, so they resolve both here and in any
consuming app.

## Consume from an app

The app must be on **Tailwind v4** (`@tailwindcss/vite`). Then:

```jsonc
// package.json
"@civitai/ui": "workspace:*"
```

```ts
// vite.config.ts
ssr: { noExternal: ['@civitai/ui'] }
```

```css
/* src/global.css */
@import 'tailwindcss';
@import 'tw-animate-css';
@import '@civitai/ui/theme.css';            /* palette + shadcn tokens + dark variant */

/* Tailwind v4 skips node_modules — make it scan this package, or the component classes get purged. */
@source '../../../packages/civitai-ui/src/lib';
```

```html
<!-- src/app.html — dark-only -->
<html lang="en" class="dark">
```

`tw-animate-css` stays an app dependency (it's a CSS `@import`). That's the whole bootstrap.

## Use a component

```svelte
<script>
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { cn } from '@civitai/ui/utils.js';
</script>
```

## Add / update components

Run the CLI **in this package** (not in an app) so new components land here with the right imports:

```bash
cd packages/civitai-ui
npx shadcn-svelte@latest add <name> --overwrite --skip-preflight
```

It reads [components.json](components.json) (aliases point at `@civitai/ui/...`) and installs any new deps
here. After adding, no app change is needed — the app already scans this package via `@source`.

## What's here

24 primitives under `src/lib/components/ui/` (button, dialog, sheet, table, dropdown-menu, select, checkbox,
input, textarea, label, badge, card, avatar, tooltip, popover, command, pagination, sonner, scroll-area,
sidebar, separator, skeleton, input-group), plus `utils.ts` (`cn` + type helpers), the `is-mobile` hook, and
`theme.css`. Civitai-specific composites (EdgeMedia, ImageGuard, masonry, moderation toolbars) belong here
too over time — built on these primitives. See [docs/packages/new-app-integration.md](../../docs/packages/new-app-integration.md) §0.
