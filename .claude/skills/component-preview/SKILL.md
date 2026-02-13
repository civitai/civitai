---
name: component-preview
description: Preview React components with real Mantine + Tailwind styling using Ladle. Use when modifying UI components, fixing visual bugs, or when the user asks to see what a component looks like. Creates Ladle stories, captures screenshots in dark/light mode, and presents them for review. Use proactively after UI changes.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task
---

# Component Preview

Preview React components in isolation using Ladle (lightweight Storybook alternative) with real Mantine v7 + Tailwind styling. No dev server needed.

## When to Use

- **After modifying a UI component** — proactively offer to preview it
- **When the user asks** "show me what it looks like" or "generate a preview"
- **When debugging visual issues** — create a story to reproduce and iterate
- **When reviewing component changes** before committing

## Prerequisites

Ladle is configured in the project root:
- `.ladle/components.tsx` — Global provider with MantineProvider + theme
- `.ladle/config.mjs` — Story discovery config
- `.ladle/vite.config.ts` — Vite config with `~/` path alias + PostCSS

If these don't exist in the current worktree, copy them from main or create them. See [Setup Reference](#setup-reference) below.

## Workflow

### 1. Create/Update the Story

Create a `.stories.tsx` file near the component being previewed:

```
src/components/MyComponent/MyComponent.stories.tsx
src/pages/challenges/EligibleModels.stories.tsx
```

**Story structure:**
```tsx
import { /* Mantine components */ } from '@mantine/core';
// Import the component or recreate the relevant JSX

// Mock data that represents realistic API responses
const mockData = [ ... ];

// Render the component with different states
function Preview({ data }) {
  return (
    <div style={{ width: 320 }}> {/* Constrain to realistic width */}
      <MyComponent data={data} />
    </div>
  );
}

/** Default state */
export const Default = () => <Preview data={mockData} />;

/** Empty state */
export const Empty = () => <Preview data={[]} />;

/** Loading or edge case states */
export const LongList = () => <Preview data={longMockData} />;
```

**Important patterns:**
- Set a realistic `width` on the wrapper (e.g., 320px for sidebar, 600px for main content)
- Copy the exact Mantine component props and Tailwind classes from the real component
- Copy any inline `styles` props from the parent context (e.g., Accordion styles)
- Use `useComputedColorScheme` and `useMantineTheme` if the component uses them
- Create 2-4 variants showing different states (default, empty, single item, overflow)

### 2. Start Ladle

```bash
# Check if Ladle is already running
curl -s -o /dev/null -w "%{http_code}" http://localhost:61111/

# If not running, start it (from project root or worktree root)
cd <worktree-path>
npx ladle serve --port 61111 &
# Wait for it to be ready (~3-5 seconds)
```

Ladle auto-discovers stories matching `src/**/*.stories.tsx`.

### 3. Capture Screenshots

Use the browser-automation skill to capture cropped, padded screenshots:

```bash
# Create a browser session
node ~/.claude/skills/browser-automation/cli.mjs session http://localhost:61111 --name ladle

# Capture all story variants in dark and light themes
node ~/.claude/skills/browser-automation/cli.mjs run "
  const stories = [
    { name: 'default', path: 'my-component--default' },
    { name: 'empty', path: 'my-component--empty' },
  ];
  const themes = ['dark', 'light'];
  const dir = '<session-screenshots-dir>';

  for (const theme of themes) {
    for (const story of stories) {
      await page.goto('http://localhost:61111/?story=' + story.path + '&theme=' + theme + '&mode=preview');
      await page.waitForTimeout(800);
      const wrapper = page.locator('.ladle-story-wrapper');
      await wrapper.screenshot({ path: dir + '/crop-' + theme + '-' + story.name + '.png' });
    }
  }
" --label "Component preview screenshots" -s ladle
```

**Story path format:** The story path is derived from the file name and export name:
- File: `EligibleModels.stories.tsx`, Export: `Default` -> path: `eligible-models--default`
- File: `ModelCard.stories.tsx`, Export: `WithBadge` -> path: `model-card--with-badge`

Pattern: kebab-case filename + `--` + kebab-case export name.

### 4. Present to User

1. **Show screenshots inline** using the Read tool on the PNG files
2. **Open for the user** if they want to see them in their image viewer:
   ```bash
   start "" "<path-to-screenshot>"
   ```
3. **Ask for feedback** — "Does this look right? Want me to adjust anything?"
4. **Iterate** — if they want changes, modify the component, re-capture, re-present

## Handling Complex Components

Some components depend heavily on app context. When this happens:

### Easy (just do it)
- Presentational components (badges, cards, lists, accordions)
- Components that only use Mantine + Tailwind
- Components with simple props

### Medium (mock the data)
- Components that use tRPC data — extract the type and create mock objects
- Components with images — use placeholder divs or null image fallbacks
- Components with links — use `<div>` or `<a href="#">` instead of Next.js `<Link>`

### Hard (raise to user)
- Components deeply coupled to multiple providers (auth, router, tRPC context)
- Components using complex hooks that call APIs
- Components with heavy CSS module dependencies

**When encountering hard cases, tell the user:**
> "This component depends on [auth/router/tRPC context]. I can either:
> 1. Mock out the dependencies (more setup, more accurate)
> 2. Extract just the visual parts into the story (faster, close enough)
> 3. Skip the preview and we can check it on the dev server instead
>
> What would you prefer?"

## Setup Reference

If Ladle isn't configured in the worktree, create these files:

### `.ladle/components.tsx`
```tsx
import { MantineProvider, createTheme, Modal } from '@mantine/core';
import type { GlobalProvider } from '@ladle/react';

import '@mantine/core/styles.layer.css';
import '../src/styles/globals.css';

// Theme subset from src/providers/ThemeProvider.tsx
const theme = createTheme({
  components: {
    Badge: {
      styles: { leftSection: { lineHeight: 1 } },
      defaultProps: { radius: 'sm', variant: 'light' },
    },
    ActionIcon: {
      defaultProps: { color: 'gray', variant: 'subtle' },
    },
    Tooltip: {
      defaultProps: { withArrow: true },
    },
  },
  colors: {
    dark: ['#C1C2C5','#A6A7AB','#8c8fa3','#5C5F66','#373A40','#2C2E33','#25262B','#1A1B1E','#141517','#101113'],
    blue: ['#E7F5FF','#D0EBFF','#A5D8FF','#74C0FC','#4DABF7','#339AF0','#228BE6','#1C7ED6','#1971C2','#1864AB'],
  },
  white: '#fefefe',
  black: '#222',
});

export const Provider: GlobalProvider = ({ children, globalState }) => (
  <MantineProvider
    theme={theme}
    defaultColorScheme={globalState.theme === 'dark' ? 'dark' : 'light'}
    forceColorScheme={globalState.theme === 'dark' ? 'dark' : 'light'}
  >
    <div className="ladle-story-wrapper" style={{ padding: 24, width: 'fit-content' }}>
      {children}
    </div>
  </MantineProvider>
);
```

### `.ladle/config.mjs`
```js
/** @type {import('@ladle/react').UserConfig} */
export default {
  stories: 'src/**/*.stories.tsx',
  defaultStory: '',
  viteConfig: '.ladle/vite.config.ts',
};
```

### `.ladle/vite.config.ts`
```ts
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '~': path.resolve(__dirname, '../src') },
  },
  css: {
    postcss: path.resolve(__dirname, '..'),
  },
});
```

### Ensure Ladle is installed
```bash
pnpm add -D @ladle/react
```

## Tips

- **Dark theme first** — Civitai defaults to dark mode, so capture dark first
- **Constrain width** — always set a width matching the real context (sidebar = ~320px, main content = ~600px, full page = ~1200px)
- **Copy parent styles** — if the component lives inside an Accordion, Card, or other container, replicate those parent styles in the story
- **Keep stories temporary** — stories for one-off reviews can be deleted after; stories for reusable components can stay
- **Ladle port** — always use 61111 to avoid conflicts with dev server (3000) and other services
