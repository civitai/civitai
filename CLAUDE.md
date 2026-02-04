# Civitai Development Guide

## How to work with us
We use markdown documents to discuss plans. Documentation goes in the `docs/` folder.

### Inline Comments
Occasionally, we comment back and forth as we make plans. Comments from us, are marked with `@dev:` and you can leave comments as well with `@ai:`. Please make comments inline in the document. If there are actions are requested in my comments, please take them.

**New Comment Marking**: When you add new comments, use an asterisk after the mention (e.g., `@justin:*` or `@meta:*`). Once you reply or acknowledge a comment, remove the asterisk so that I know it's been seen. Note: Sometimes I might forget to add the asterisk to my new comments, so please check all comments regardless of marking.

**Example**
```
@dev: This comment has been processed (asterisk removed)
@ai: Of course
@dev:* This is a new comment that needs attention
```

## Tech Stack Overview

### Core Technologies
- **Framework**: Next.js 14 with TypeScript
- **UI Library**: Mantine v7
- **Styling**: Tailwind CSS + SCSS Modules
- **Database**: PostgreSQL with Prisma ORM
- **API**: tRPC
- **State Management**: Zustand
- **Authentication**: NextAuth
- **Search**: Meilisearch
- **Image Processing**: Sharp

### Additional Libraries
- React Query (Tanstack Query) for data fetching
- React Hook Form with Zod validation
- Tiptap for rich text editing
- Chart.js for data visualization
- Stripe/Paddle/PayPal for payments

## Build Commands

### Development
**Always use the `/dev-server` skill** to manage dev servers. Never use `pnpm run dev` directly.

### Build & Deploy
```bash
pnpm run build            # Production build
```

### Code Quality
```bash
pnpm run typecheck        # Run TypeScript type checking
pnpm run lint             # Run ESLint
pnpm run prettier:check   # Check Prettier formatting
pnpm run prettier:write   # Auto-fix Prettier formatting
```

### Testing
```bash
pnpm test                 # Run Playwright tests
pnpm run test:ui          # Run tests with UI
```

### Database
```bash
pnpm run db:migrate:empty  # Create an empty migration file
```

### Release (requires user permission)
```bash
pnpm run release          # Patch release (0.0.x) - default
pnpm run release:minor    # Minor release (0.x.0)
pnpm run release:major    # Major release (x.0.0)
```
**IMPORTANT**: Never run release commands without explicit user approval. These commands bump the version, push tags, and rebase the release branch.

## Component Standards

### File Structure
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

### Component Patterns

#### 1. Mantine Components
```tsx
import { Button, Group, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
```

#### 2. Tailwind Classes with clsx
```tsx
import clsx from 'clsx';

<div className={clsx('flex items-center gap-2', conditionalClass && 'bg-blue-500')} />
```

#### 3. SCSS Modules (when needed)
```tsx
import styles from './Component.module.scss';

<div className={styles.container} />
```

#### 4. TypeScript Patterns
- Use type imports when possible: `import type { ButtonProps } from '@mantine/core'`
- Define Props interfaces for components
- Use enums from `~/shared/utils/prisma/enums`

### Coding Standards

#### Imports Order
1. External libraries (React, Mantine, etc.)
2. Internal components (~/components/...)
3. Hooks (~/hooks/...)
4. Server/API code (~/server/...)
5. Utils and helpers (~/utils/...)
6. Types and enums
7. Styles

#### State Management
- Use Zustand for global state
- Use React Query for server state
- Use React Hook Form for forms

#### API Calls
```tsx
import { trpc } from '~/utils/trpc';

const { data, isLoading } = trpc.user.getProfile.useQuery();
```

#### Authentication
```tsx
import { useCurrentUser } from '~/hooks/useCurrentUser';

const currentUser = useCurrentUser();
```

## Environment Setup

### Required Environment Variables
- Database connection strings
- Authentication providers
- S3/CloudFlare credentials
- Payment provider keys
- Search service endpoints

### Local Development
1. Install dependencies: `pnpm install`
2. Generate Prisma client: `pnpm run db:generate`
3. Start dev server: Use `/dev-server` skill

## Important Notes

### Performance
- Use dynamic imports for heavy components
- Implement virtual scrolling for large lists
- Optimize images with Next.js Image component

### Security
- Never commit secrets or API keys
- Use environment variables
- Sanitize user input with sanitize-html
- Follow authentication best practices

### Before Committing
1. Run type checking: `pnpm run typecheck`
2. Run linting: `pnpm run lint`
3. Format code: `pnpm run prettier:write`
4. Test changes locally

## Common Patterns

### Infinite Scroll
Use MasonryGrid or virtual scrolling components with React Query infinite queries.

### Modals
Use Mantine modals with proper accessibility and keyboard handling.

#### Dialog Registry System
The project uses a dialog-registry system for managing modals:
- Register dialogs in `src/components/Dialog/dialog-registry.ts` or `dialog-registry2.ts`
- Use `DialogProvider` for context-based modal management
- `RoutedDialogProvider` for URL-based modal state
- Access dialogs through the registry for consistent modal handling across the app

### Forms
Use React Hook Form with Zod schemas for validation.

### File Uploads
Use the S3 upload hooks and providers in the codebase.

### Image Handling
Use EdgeImage component for optimized image loading with CDN support.

## Feature Documentation

Feature-specific documentation lives in `docs/features/`. Before implementing a feature, check if documentation exists:

### Core Systems Reference
| System | Documentation |
|--------|--------------|
| Image Resources | [docs/features/image-resources.md](docs/features/image-resources.md) |
| NSFW Filtering | [docs/features/nsfw-filtering.md](docs/features/nsfw-filtering.md) |
| Buzz Accounts | [docs/features/buzz-accounts.md](docs/features/buzz-accounts.md) |
| Notifications | [docs/features/notifications.md](docs/features/notifications.md) |
| Metrics/Analytics | [docs/features/metrics-analytics.md](docs/features/metrics-analytics.md) |
| Bitwise Flags | [docs/features/bitwise-flags.md](docs/features/bitwise-flags.md) |
| LoRA Training | [docs/features/lora-training.md](docs/features/lora-training.md) |
| Image Edit Training | [docs/features/image-edit-training.md](docs/features/image-edit-training.md) |

## Troubleshooting

### Memory Issues
Use cross-env NODE_OPTIONS with increased memory:
```bash
pnpm run dev-debug  # Includes --max_old_space_size=8192
```

### Build Failures
1. Clear .next folder
2. Clear node_modules and reinstall
3. Check for circular dependencies
4. Ensure all environment variables are set

### Database Issues
1. Check connection string
2. Run migrations: `pnpm run db:migrate`
3. Regenerate client: `pnpm run db:generate`
