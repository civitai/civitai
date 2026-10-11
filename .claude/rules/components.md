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

- **State:** Zustand for global state, React Query for server state, React Hook Form (with Zod schemas) for forms.
- **API calls:** `import { trpc } from '~/utils/trpc'`, then `trpc.user.getProfile.useQuery()`.
- **Current user:** `import { useCurrentUser } from '~/hooks/useCurrentUser'`.
- **File uploads:** use the S3 upload hooks and providers.

## Performance and media

- Use dynamic imports for heavy components and virtual scrolling for large lists.
- Serve images through `EdgeImage`/`EdgeMedia` (CDN-optimised), not `next/image`.
- Infinite scroll: `MasonryGrid` or virtual scrolling with React Query infinite queries.

## Modals

Use Mantine modals with proper accessibility and keyboard handling, managed through the dialog registry:
- Register dialogs in `src/components/Dialog/dialog-registry2.ts`; URL-routed ones in `src/components/Dialog/routed-dialog-registry.ts`.
- `DialogProvider` for context-based modal management; `RoutedDialogProvider` for URL-based modal state.
- Open dialogs through the registry so modal handling stays consistent.
