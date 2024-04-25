import { ColorScheme, ColorSchemeProvider, MantineProvider } from '@mantine/core';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { setCookie } from 'cookies-next';

export function ThemeProvider({
  children,
  colorScheme: cookeColorScheme,
}: {
  children: React.ReactNode;
  colorScheme: ColorScheme;
}) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(cookeColorScheme ?? 'dark');
  const toggleColorScheme = useCallback(
    (value?: ColorScheme) => {
      const nextColorScheme = value || (colorScheme === 'dark' ? 'light' : 'dark');

      setColorScheme(nextColorScheme);
      setCookie('mantine-color-scheme', nextColorScheme, {
        expires: dayjs().add(1, 'year').toDate(),
      });
    },
    [colorScheme]
  );

  useEffect(() => {
    if (colorScheme === undefined && typeof window !== 'undefined') {
      const osColor = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      setColorScheme(osColor);
    }
    // elevate colorscheme class to body for tailwind
    if (typeof window !== 'undefined') {
      const body = document.querySelector('body');
      body?.removeAttribute('class');
      body?.classList.add(colorScheme);
    }
  }, [colorScheme]);

  return (
    <ColorSchemeProvider colorScheme={colorScheme} toggleColorScheme={toggleColorScheme}>
      <MantineProvider
        withCSSVariables
        withGlobalStyles
        withNormalizeCSS
        theme={{
          colorScheme: colorScheme,
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
        }}
      >
        {children}
      </MantineProvider>
    </ColorSchemeProvider>
  );
}
