import { MantineProvider, createTheme, Modal } from '@mantine/core';
import type { GlobalProvider } from '@ladle/react';

// 🔴 ORDER MATCHES `src/pages/_app.tsx` — globals FIRST, then Mantine's LAYERED stylesheet.
// `styles.layer.css` wraps every Mantine rule in `@layer mantine`, and a layer's precedence
// is fixed by where it is first DECLARED. Importing it before `globals.css` declares the
// layer ahead of Tailwind's own, so preflight wins and Mantine components render with their
// structure but none of their spacing — the tab bar in particular collapsed to unpadded
// labels with each tab's icon abutting the previous tab's text. Nothing errors; the stories
// simply stop being a picture of the app.
import '../src/styles/globals.css';
import '@mantine/core/styles.layer.css';

// Subset of the app theme (from src/providers/ThemeProvider.tsx)
const theme = createTheme({
  components: {
    Modal: Modal.extend({
      styles: {
        content: { maxWidth: '100%', overflowX: 'hidden' },
        inner: { paddingLeft: 0, paddingRight: 0 },
      },
    }),
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
    dark: [
      '#C1C2C5',
      '#A6A7AB',
      '#8c8fa3',
      '#5C5F66',
      '#373A40',
      '#2C2E33',
      '#25262B',
      '#1A1B1E',
      '#141517',
      '#101113',
    ],
    blue: [
      '#E7F5FF',
      '#D0EBFF',
      '#A5D8FF',
      '#74C0FC',
      '#4DABF7',
      '#339AF0',
      '#228BE6',
      '#1C7ED6',
      '#1971C2',
      '#1864AB',
    ],
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
