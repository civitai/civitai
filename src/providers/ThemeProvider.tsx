import type { MantineColorScheme } from '@mantine/core';
import { ColorSchemeScript, createTheme, MantineProvider, Modal, colorsTuple } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { DateLocaleProvider } from '~/providers/DateLocaleProvider';

const theme = createTheme({
  components: {
    Modal: Modal.extend({
      styles: {
        content: { maxWidth: '100%', overflowX: 'hidden' },
        inner: { paddingLeft: 0, paddingRight: 0 },
      },
      defaultProps: { removeScrollProps: { allowPinchZoom: true } },
    }),
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
    Popover: { styles: { dropdown: { maxWidth: '100vw' } }, defaultProps: { withinPortal: false } },
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
      defaultProps: { radius: 'sm', variant: 'light' },
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
    Divider: {
      defaultProps: {
        labelPosition: 'left',
      },
    },
    ActionIcon: {
      defaultProps: {
        color: 'gray',
        variant: 'subtle',
      },
    },
    // Text: {
    //   defaultProps: {
    //     size: 'sm',
    //   },
    // },
    // InputWrapper: {
    //   classNames: { label: 'w-full' },
    // },
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
    gray: [
      '#f8f9fa',
      '#f1f3f5',
      '#e9ecef',
      '#dee2e6',
      '#ced4da',
      '#adb5bd',
      '#868e96',
      '#495057',
      '#343a40',
      '#212529',
    ],
    yellow: [
      '#FFF9DB',
      '#FFF3BF',
      '#FFEC99',
      '#FFE066',
      '#FFD43B',
      '#FCC419',
      '#FAB005',
      '#F59F00',
      '#F08C00',
      '#E67700',
    ],
    green: [
      '#EBFBEE',
      '#D3F9D8',
      '#B2F2BB',
      '#8CE99A',
      '#69DB7C',
      '#51CF66',
      '#40C057',
      '#37B24D',
      '#2F9E44',
      '#2B8A3E',
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
    red: [
      '#fff5f5',
      '#ffe3e3',
      '#ffc9c9',
      '#ffa8a8',
      '#ff8787',
      '#ff6b6b',
      '#fa5252',
      '#f03e3e',
      '#e03131',
      '#c92a2a',
    ],
    orange: [
      '#fff4e6',
      '#ffe8cc',
      '#ffd8a8',
      '#ffc078',
      '#ffa94d',
      '#ff922b',
      '#fd7e14',
      '#f76707',
      '#e8590c',
      '#d9480f',
    ],
    lime: [
      '#f4fce3',
      '#e9fac8',
      '#d8f5a2',
      '#c0eb75',
      '#a9e34b',
      '#94d82d',
      '#82c91e',
      '#74b816',
      '#66a80f',
      '#5c940d',
    ],
    gold: [
      '#F6EDDF',
      '#F2E4CF',
      '#EDDBBF',
      '#E9D2AF',
      '#E5C99F',
      '#E0C08F',
      '#DCB77F',
      '#D8AE6F',
      '#D3A55F',
      '#CD9848',
    ],
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
    // Do not attempt to add a buzz class here. Sadly, Mantine doesn't listen to CSS local variable overwrites,
    // Meaning that this is as useless as using the exact color combination. This is not the case with Tailwind.
    // We have a `buzz` color in Tailwind, that uses all cool tailwind stuff. Keep that up.
    // Read more here (There ain't much to read...): https://github.com/orgs/mantinedev/discussions/1720
    // buzz: colorsTuple('rgb(var(--buzz-color))'),
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
    <>
      <ColorSchemeScript defaultColorScheme={cookieColorScheme} />
      <MantineProvider theme={theme} defaultColorScheme={cookieColorScheme ?? 'dark'}>
        <Notifications />
        <DateLocaleProvider>{children}</DateLocaleProvider>
      </MantineProvider>
    </>
  );
}
