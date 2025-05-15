import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';

import { MantineColorScheme, ColorSchemeScript, createTheme, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';

const theme = createTheme({
  components: {
    Modal: {
      styles: {
        modal: { maxWidth: '100%' },
        inner: { paddingLeft: 0, paddingRight: 0 },
      },
      // defaultProps: {
      //   target:
      //     typeof window !== 'undefined' ? document.getElementById('root') : undefined,
      // },
    },
    Drawer: {
      styles: {
        drawer: {
          containerName: 'drawer',
          containerType: 'inline-size',
          display: 'flex',
          flexDirection: 'column',
        },
        body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
        header: { margin: 0 },
      },
      // defaultProps: {
      //   target:
      //     typeof window !== 'undefined' ? document.getElementById('root') : undefined,
      // },
    },
    Tooltip: {
      defaultProps: { withArrow: true },
    },
    Popover: { styles: { dropdown: { maxWidth: '100vw' } } },
    Rating: { styles: { symbolBody: { cursor: 'pointer' } } },
    Switch: {
      styles: {
        body: { verticalAlign: 'top' },
        track: { cursor: 'pointer' },
        label: { cursor: 'pointer' },
      },
    },
    Radio: {
      styles: {
        radio: { cursor: 'pointer' },
        label: { cursor: 'pointer' },
      },
    },
    Badge: {
      styles: { leftSection: { lineHeight: 1 } },
      defaultProps: { radius: 'sm' },
    },
    Checkbox: {
      styles: {
        input: { cursor: 'pointer' },
        label: { cursor: 'pointer' },
      },
    },
    Menu: {
      styles: {
        itemLabel: { display: 'flex' },
      },
    },
    SegmentedControl: {
      defaultProps: {
        transitionDuration: 0,
      },
    },
    // InputWrapper: {
    //   classNames: { label: 'w-full' },
    // },
  },
  colors: {
    accent: [
      '#F4F0EA',
      '#E8DBCA',
      '#E2C8A9',
      '#E3B785',
      '#EBA95C',
      '#FC9C2D',
      '#E48C27',
      '#C37E2D',
      '#A27036',
      '#88643B',
    ],
    success: [
      '#9EC3B8',
      '#84BCAC',
      '#69BAA2',
      '#4CBD9C',
      '#32BE95',
      '#1EBD8E',
      '#299C7A',
      '#2F826A',
      '#326D5C',
      '#325D51',
    ],
  },
  white: '#fefefe',
  black: '#222',
  other: {
    fadeIn: `opacity 200ms ease-in`,
  },
  respectReducedMotion: true,
});

export function ThemeProvider({
  children,
  colorScheme: cookieColorScheme,
}: {
  children: React.ReactNode;
  colorScheme: MantineColorScheme;
}) {
  return (
    <ColorSchemeScript defaultColorScheme={cookieColorScheme}>
      <MantineProvider theme={theme} defaultColorScheme={cookieColorScheme ?? 'dark'}>
        <Notifications />
        {children}
      </MantineProvider>
    </ColorSchemeScript>
  );
}
