import type { MantineColorScheme } from '@mantine/core';
import { ColorSchemeScript, createTheme, MantineProvider, ScrollArea } from '@mantine/core';
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
      defaultProps: {
        scrollAreaComponent: ScrollArea.Autosize,
      },
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
    // InputWrapper: {
    //   classNames: { label: 'w-full' },
    // },
  },
  colors: {
    dark: [
      '#C9C9C9',
      '#B8B8B8',
      '#828282',
      '#696969',
      '#424242',
      '#3B3B3B',
      '#2E2E2E',
      '#242424',
      '#1F1F1F',
      '#141414',
    ],
    gray: [
      '#F8F9FA',
      '#F1F3F5',
      '#E9ECEF',
      '#DEE2E6',
      '#CED4DA',
      '#ADB5BD',
      '#868E96',
      '#495057',
      '#343A40',
      '#212529',
    ],
    red: [
      '#FFF5F5',
      '#FFE3E3',
      '#FFC9C9',
      '#FFA8A8',
      '#FF8787',
      '#FF6B6B',
      '#FA5252',
      '#F03E3E',
      '#E03131',
      '#C92A2A',
    ],
    pink: [
      '#FFF0F6',
      '#FFDEEB',
      '#FCC2D7',
      '#FAA2C1',
      '#F783AC',
      '#F06595',
      '#E64980',
      '#D6336C',
      '#C2255C',
      '#A61E4D',
    ],
    grape: [
      '#F8F0FC',
      '#F3D9FA',
      '#EEBEFA',
      '#E599F7',
      '#DA77F2',
      '#CC5DE8',
      '#BE4BDB',
      '#AE3EC9',
      '#9C36B5',
      '#862E9C',
    ],
    violet: [
      '#F3F0FF',
      '#E5DBFF',
      '#D0BFFF',
      '#B197FC',
      '#9775FA',
      '#845EF7',
      '#7950F2',
      '#7048E8',
      '#6741D9',
      '#5F3DC4',
    ],
    indigo: [
      '#EDF2FF',
      '#DBE4FF',
      '#BAC8FF',
      '#91A7FF',
      '#748FFC',
      '#5C7CFA',
      '#4C6EF5',
      '#4263EB',
      '#3B5BDB',
      '#364FC7',
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
    cyan: [
      '#E3FAFC',
      '#C5F6FA',
      '#99E9F2',
      '#66D9E8',
      '#3BC9DB',
      '#22B8CF',
      '#15AABF',
      '#1098AD',
      '#0C8599',
      '#0B7285',
    ],
    teal: [
      '#E6FCF5',
      '#C3FAE8',
      '#96F2D7',
      '#63E6BE',
      '#38D9A9',
      '#20C997',
      '#12B886',
      '#0CA678',
      '#099268',
      '#087F5B',
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
    lime: [
      '#F4FCE3',
      '#E9FAC8',
      '#D8F5A2',
      '#C0EB75',
      '#A9E34B',
      '#94D82D',
      '#82C91E',
      '#74B816',
      '#66A80F',
      '#5C940D',
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
    orange: [
      '#FFF4E6',
      '#FFE8CC',
      '#FFD8A8',
      '#FFC078',
      '#FFA94D',
      '#FF922B',
      '#FD7E14',
      '#F76707',
      '#E8590C',
      '#D9480F',
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
        {children}
      </MantineProvider>
    </>
  );
}
