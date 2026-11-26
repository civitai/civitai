---
paths:
  - "src/components/**"
  - "src/pages/**/*.tsx"
  - "src/hooks/**"
  - "src/store/**"
  - "src/providers/**"
---

# Frontend (main app)

## File structure

```
src/
├── components/          # React components
│   ├── ComponentName/   # Component folder
│   │   ├── ComponentName.tsx
│   │   ├── ComponentName.module.scss  # Optional SCSS module
│   │   └── utils.ts     # Component utilities
├── hooks/              # Custom React hooks
├── server/             # Server-side code
├── utils/              # Shared utilities
└── store/              # Zustand stores
```

## Components and styling

- **Mantine first:** `import { Button, Group, Text } from '@mantine/core'`, icons from `@tabler/icons-react`.
- **Colours:** theme tokens (Tailwind classes with `dark:` variants, or `var(--mantine-color-*)`); no hex literals in components.
- **Responsive:** do layout in CSS or Tailwind variants (`@max-md:` and the other `@` variants query the nearest `@container`; `max-md:` queries the viewport), not in JS. `useIsMobile()` measures the nearest container, not the viewport (pass `{ type: 'media' }` for a viewport query).
- **Tailwind with `clsx`:** `<div className={clsx('flex items-center gap-2', cond && 'bg-blue-500')} />`.
- **SCSS modules only when needed:** `import styles from './Component.module.scss'`.
- **TypeScript:** use `import type { ButtonProps } from '@mantine/core'`, define Props interfaces, and take enums from `~/shared/utils/prisma/enums`.

### A `Popover` inside anything that clips needs `withinPortal`

Pass `withinPortal` explicitly on a `Popover` inside a `Card`, an `overflow-hidden` wrapper or a scroll area.

Why: `src/providers/ThemeProvider.tsx` sets `Popover` `withinPortal: false` app-wide, so the dropdown renders inside the container and is clipped, with nothing in the JSX pointing at the cause. Only `Popover` has this default (`HoverCard` has no theme entry; `Tooltip`'s sets `withArrow` alone), so grepping for the prop doesn't show which sites needed it.

## Import order

1. External libraries (React, Mantine, ...)
2. Internal components (`~/components/...`)
3. Hooks (`~/hooks/...`)
4. Server/API code (`~/server/...`)
5. Utils and helpers (`~/utils/...`)
6. Types and enums
7. Styles

## Data, state and forms

- **State:** Zustand for global state, React Query for server state, React Hook Form (with Zod schemas) for forms. Form entry point: `~/libs/form` (`useForm` + `Form` + `Input*`); generation forms use form-graph.
- **API calls:** `import { trpc } from '~/utils/trpc'`, then `trpc.user.getProfile.useQuery()`.
- **Current user:** `import { useCurrentUser } from '~/hooks/useCurrentUser'`.
- **File uploads:** use the S3 upload hooks and providers.

## Performance and media

- Use dynamic imports for heavy components and virtual scrolling for large lists.
- Serve images through `EdgeImage`/`EdgeMedia` (CDN-optimised), not `next/image`.
- Images are served directly: the built-in Next image optimizer is disabled (`images.unoptimized`). Don't re-enable it, add a loader, or set `unoptimized={false}`.
- Infinite scroll: `MasonryGrid` or virtual scrolling with React Query infinite queries.

## Modals

- Open a dialog with `openDialog(() => import('…/XModal'), props)` (`src/components/Dialog/openDialog.ts`): pass the import, so the modal loads on first open rather than with the opener (the import-cycle guards still count it as an edge). The dialog component calls `useDialogContext()`. No new file per modal; a shared opener (`Dialog/triggers/`) earns its place only with behaviour (a fixed id, a check) or two or more callers.
- Confirms: `openConfirm` (`Dialog/Common/ConfirmDialog`). Alerts: `openAlert` (`Dialog/Common/AlertDialog`). A titled modal around arbitrary content: `openContentDialog` (`Dialog/Common/ContentDialog`). `@mantine/modals` is gone; `no-unlisted-dialog-open` fails on an import of it, and on a new direct `dialogStore.trigger` outside `Dialog/`. A dialog's `Modal`/`Drawer` takes `closeOnEscape` from `useDialogContext()` (the spread, or `dialog.closeOnEscape && …`), so Escape closes only the top dialog; the guard checks it. A closed dialog leaves `dialogs` at once but stays mounted in the store's `closing` list until its exit transition ends (`onExitTransitionEnd`, which the spread passes on; a 1s fallback otherwise). Tests that wipe the page with dialogs open call `dialogStore.closeAll()` first, which skips the transition.
- URL-routed dialogs: the URL rule in a `<name>.dialog.ts` in `src/components/Dialog/routed-dialog/` (it names its modal only through `import type`), listed in `registry.ts`; the component goes in `RoutedDialogProvider`'s map.
- `DialogProvider` renders the dialog stack; `RoutedDialogProvider` handles URL-based modal state.
