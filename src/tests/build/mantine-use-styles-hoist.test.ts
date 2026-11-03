import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as ReactEsm from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup as renderEsm } from 'react-dom/server';
import * as MantineEsm from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { theme as appTheme } from '~/providers/ThemeProvider';
import {
  MANTINE_USE_STYLES_HOIST_GATE_KEY,
  setMantineUseStylesHoistGate,
} from '~/server/utils/mantine-styles-hoist-gate';

/**
 * Pins the `useStyles` hoist in `patches/@mantine__core@7.17.8.patch`, a backport of Mantine 9's
 * per-instance resolution. Unpatched (and with the gate off), every `getStyles(selector)` call
 * re-runs the component's vars resolver, re-merges every selector's vars and re-resolves the theme
 * and component styles/classNames. With the gate on, `useStyles` resolves those once per component
 * instance and `getStyles` reads them.
 *
 * The contract is that the markup does not change: the server may run either path and the client
 * always runs the original one, so the two must render the same bytes. Each case below renders a
 * page-shaped tree of Mantine components twice, gate off and gate on, and compares the strings.
 * The trees go through the Styles API at every level the hoist touches: theme `classNames`,
 * `styles` and `vars` (objects and functions), the same on the instance, `style` as an object, a
 * function and an array, per-call `getStyles` options, `unstyled`, static classes on and off, a
 * custom prefix, headless mode and a styles transform.
 *
 * Both builds are checked: `@mantine/core` as Vitest resolves it (the `esm/` build, as the app's
 * bundler does), and the `cjs/` build loaded with `require`.
 *
 * 🔴 If a test here fails after a Mantine upgrade, the patch no longer applies to the code it was
 * written for: re-read `use-styles`, `get-style` and `get-class-name` in the new version,
 * regenerate the patch or drop it, and update `package.json` → `pnpm.patchedDependencies`.
 */

type Lib = Record<string, unknown>;
type Props = Record<string, unknown> | null;
type H = (type: unknown, props?: Props, ...children: unknown[]) => ReactElement;
type Build = { name: 'esm' | 'cjs'; M: Lib; h: H; render: (el: ReactElement) => string };

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
// `@mantine/core` does not export `./package.json`; its main entry is `cjs/index.cjs`.
const MANTINE = join(dirname(requireFromRepo.resolve('@mantine/core')), '..');
const PATCHED_FILES = {
  esm: join(MANTINE, 'esm/core/styles-api/use-styles/use-styles.mjs'),
  cjs: join(MANTINE, 'cjs/core/styles-api/use-styles/use-styles.cjs'),
};

const ReactCjs = requireFromRepo('react') as typeof ReactEsm;
const ServerCjs = requireFromRepo('react-dom/server') as { renderToStaticMarkup: typeof renderEsm };

const BUILDS: Build[] = [
  {
    name: 'esm',
    M: MantineEsm as unknown as Lib,
    h: ReactEsm.createElement as unknown as H,
    render: renderEsm,
  },
  {
    name: 'cjs',
    M: requireFromRepo('@mantine/core') as Lib,
    h: ReactCjs.createElement as unknown as H,
    render: ServerCjs.renderToStaticMarkup,
  },
];

/** `M.Card.Section` and friends, failing loudly if the export is missing. */
function pick(M: Lib, path: string): unknown {
  let value: unknown = M;
  for (const key of path.split('.')) value = value == null ? value : (value as Lib)[key];
  if (value == null) throw new Error(`@mantine/core has no export ${path}`);
  return value;
}

/** One plain Button under a provider with `theme`. */
function oneButton({ M, h }: Build, theme: Lib): ReactElement {
  return h(pick(M, 'MantineProvider'), { theme }, h(pick(M, 'Button'), null, 'x'));
}

type CssMap = Record<string, Record<string, string | number | undefined>>;

/** Drives every theme-level branch: classNames, styles and vars, as objects and as functions. */
function stylesApiTheme() {
  return {
    primaryColor: 'teal',
    components: {
      Button: {
        classNames: (_t: unknown, props: Lib) => ({
          root: `theme-btn-${String(props.variant ?? 'filled')}`,
          label: 'theme-btn-label',
        }),
        styles: (_t: unknown, props: Lib): CssMap => ({
          label: { letterSpacing: props.size === 'lg' ? '1px' : '0.5px' },
          inner: { gap: 3 },
        }),
        vars: (_t: unknown, props: Lib): CssMap => ({
          root: { '--button-theme-var': props.color === 'red' ? '1px' : '2px' },
        }),
      },
      Text: { classNames: { root: 'theme-text' }, styles: { root: { wordBreak: 'break-word' } } },
      Input: {
        classNames: { input: 'theme-input', section: 'theme-input-section' },
        vars: (): CssMap => ({ wrapper: { '--input-height': '40px' } }),
      },
      InputWrapper: { styles: { label: { fontWeight: 600 } } },
      Badge: { styles: () => ({ root: { textTransform: 'none' } }) },
      Card: { classNames: [{ root: 'theme-card-a' }, () => ({ root: 'theme-card-b' })] },
    },
  };
}

/** Page-shaped: roughly the mix of components a server render produces, plus Styles API props. */
function page({ M, h }: Build): ReactElement {
  const c = (path: string, props: Lib | null, ...children: unknown[]) =>
    h(pick(M, path), props, ...children);
  const section = h('span', null, '•');
  return c(
    'Container',
    { size: 'lg' },
    c(
      'Stack',
      { gap: 'xs' },
      c('Title', { order: 3 }, 'Heading'),
      c(
        'Group',
        { gap: 'xs', justify: 'space-between', wrap: 'nowrap' },
        c('Button', null, 'Default'),
        c('Button', { variant: 'light', color: 'blue', size: 'compact-sm' }, 'Light'),
        c(
          'Button',
          { variant: 'outline', color: 'red', size: 'lg', radius: 'xl', leftSection: section },
          'Outline'
        ),
        c('Button', { loading: true, rightSection: section, fullWidth: true }, 'Loading'),
        c('Button', { variant: 'subtle', disabled: true }, 'Disabled'),
        c('ActionIcon', { variant: 'filled', 'aria-label': 'act' }, 'A'),
        c('ActionIcon', { 'aria-label': 'act2' }, 'B'),
        c('CloseButton', { 'aria-label': 'close' })
      ),
      c(
        'Group',
        { gap: 4 },
        c('Badge', { leftSection: section, color: 'green' }, 'Badge'),
        c('Badge', { variant: 'dot', size: 'lg' }, 'Dot'),
        c('Badge', { unstyled: true }, 'Unstyled'),
        c('ThemeIcon', { color: 'grape', size: 'sm' }, 'T'),
        c('Kbd', null, 'K'),
        c('Code', null, 'code'),
        c('Indicator', { label: 3, size: 16 }, c('Avatar', { alt: 'av', radius: 'xl' })),
        c('Loader', { size: 'sm', type: 'dots' })
      ),
      c(
        'Card',
        { withBorder: true, padding: 'sm', radius: 'md' },
        c('Card.Section', null, c('Text', { size: 'sm', c: 'dimmed', fw: 700 }, 'Section')),
        c('Text', { lineClamp: 2 }, 'Clamped text'),
        c('Text', { truncate: true, size: 'xs' }, 'Truncated'),
        c('Anchor', { href: '/somewhere' }, 'Link')
      ),
      c(
        'Paper',
        { shadow: 'sm', p: { base: 'xs', md: 'lg' }, mt: 'md', bg: 'dark.6' },
        c('Alert', { title: 'Notice', color: 'red', variant: 'outline' }, 'Alert body'),
        c('Progress', { value: 40 }),
        c('Divider', { label: 'or' }),
        c('Skeleton', { height: 8 })
      ),
      c(
        'Tabs',
        { defaultValue: 'a' },
        c(
          'Tabs.List',
          null,
          c('Tabs.Tab', { value: 'a' }, 'A'),
          c('Tabs.Tab', { value: 'b' }, 'B')
        ),
        c('Tabs.Panel', { value: 'a' }, 'Panel A')
      ),
      c(
        'Accordion',
        { defaultValue: 'x' },
        c(
          'Accordion.Item',
          { value: 'x' },
          c('Accordion.Control', null, 'Control'),
          c('Accordion.Panel', null, 'Panel')
        )
      ),
      c('Tooltip', { label: 'tip' }, c('Button', { size: 'xs' }, 'Tooltip target')),
      c(
        'Menu',
        null,
        c('Menu.Target', null, c('Button', null, 'Menu')),
        c('Menu.Dropdown', null, c('Menu.Item', null, 'Item'))
      ),
      c(
        'Popover',
        null,
        c('Popover.Target', null, c('Button', null, 'Popover')),
        c('Popover.Dropdown', null, 'Dropdown')
      ),
      c(
        'SimpleGrid',
        { cols: { base: 1, sm: 2 } },
        c('TextInput', {
          label: 'Name',
          description: 'Description',
          error: 'Error',
          leftSection: '@',
          placeholder: 'p',
        }),
        c('Textarea', { label: 'Bio' }),
        c('Select', { label: 'Pick', data: ['a', 'b'], defaultValue: 'a' }),
        c('Checkbox', { label: 'Check', defaultChecked: true }),
        c('Switch', { label: 'Switch' }),
        c('Radio', { label: 'Radio', value: 'r' }),
        c('Chip', { defaultChecked: true }, 'Chip'),
        c('SegmentedControl', { data: ['one', 'two'] }),
        c('Pagination', { total: 5 })
      ),
      // Instance-level Styles API: objects, functions and arrays.
      c(
        'Button',
        {
          classNames: { root: 'inst-root', label: 'inst-label' },
          styles: { label: { color: 'red' }, inner: { justifyContent: 'start' } },
          vars: (_t: unknown, props: Lib): CssMap => ({
            root: { '--button-bg': props.color === 'pink' ? 'pink' : 'black' },
          }),
          style: (t: { white: string }) => ({ outline: `1px solid ${t.white}` }),
          color: 'pink',
        },
        'Instance'
      ),
      c(
        'Text',
        {
          classNames: (_t: unknown, props: Lib) => ({ root: `inst-fn-${String(props.size)}` }),
          styles: () => ({ root: { opacity: 0.5 } }),
          style: [{ margin: 1 }, () => ({ padding: 2 })],
          size: 'lg',
        },
        'Styled text'
      ),
      c('TextInput', {
        label: 'Styled input',
        classNames: { input: 'inst-input', label: 'inst-label' },
        styles: { input: { color: 'blue' } },
      })
    )
  );
}

type Scenario = {
  name: string;
  /** A string the gate-off render must contain, so the fixture cannot pass by rendering nothing. */
  marker: string;
  wrap: (b: Build, tree: ReactElement) => ReactElement;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'the app theme, as ThemeProvider configures it',
    marker: 'mantine-Button-root',
    wrap: ({ M, h }, tree) =>
      h(
        pick(M, 'MantineProvider'),
        { theme: appTheme, defaultColorScheme: 'dark', withCssVariables: false },
        tree
      ),
  },
  {
    name: 'a theme using every Styles API level',
    marker: '--button-theme-var',
    wrap: ({ M, h }, tree) => h(pick(M, 'MantineProvider'), { theme: stylesApiTheme() }, tree),
  },
  {
    name: 'a custom class prefix',
    marker: 'civ-Button-root',
    wrap: ({ M, h }, tree) =>
      h(pick(M, 'MantineProvider'), { theme: stylesApiTheme(), classNamesPrefix: 'civ' }, tree),
  },
  {
    name: 'static classes off',
    marker: 'theme-btn-filled',
    wrap: ({ M, h }, tree) =>
      h(pick(M, 'MantineProvider'), { theme: stylesApiTheme(), withStaticClasses: false }, tree),
  },
  {
    name: 'headless mode',
    marker: 'inst-root',
    wrap: ({ M, h }, tree) =>
      h(pick(M, 'HeadlessMantineProvider'), { theme: stylesApiTheme() }, tree),
  },
  {
    name: 'a styles transform',
    marker: 'tx-root',
    wrap: ({ M, h }, tree) =>
      h(
        pick(M, 'MantineProvider'),
        {
          theme: stylesApiTheme(),
          stylesTransform: {
            sx: () => () => '',
            styles: () => (style: unknown) =>
              style ? { root: 'tx-root', label: 'tx-label', input: 'tx-input' } : undefined,
          },
        },
        tree
      ),
  },
];

afterEach(() => {
  setMantineUseStylesHoistGate(undefined);
});

describe('the gate the patch reads', () => {
  it.each(['esm', 'cjs'] as const)('the %s build reads the key the server installs', (build) => {
    const source = readFileSync(PATCHED_FILES[build], 'utf8');
    expect(MANTINE_USE_STYLES_HOIST_GATE_KEY).toBe('civitai.mantine.useStylesHoist');
    expect(source).toContain(`Symbol.for('${MANTINE_USE_STYLES_HOIST_GATE_KEY}')`);
  });
});

describe.each(BUILDS)('patched @mantine/core useStyles hoist ($name)', (build) => {
  it.each(SCENARIOS)('renders the same HTML with the gate off and on: $name', (scenario) => {
    const tree = () => scenario.wrap(build, page(build));

    setMantineUseStylesHoistGate(undefined);
    const off = build.render(tree());

    const gate = vi.fn(() => true);
    setMantineUseStylesHoistGate(gate);
    const on = build.render(tree());

    // Positive controls: the patched code consulted the gate, and the fixture rendered the
    // Styles API output it is meant to compare.
    expect(gate).toHaveBeenCalled();
    expect(off).toContain(scenario.marker);
    expect(on).toBe(off);
  });

  it('resolves vars once per instance with the gate on, per getStyles call with it off', () => {
    // A plain Button asks getStyles for root, inner and label.
    const vars = vi.fn(() => ({ root: { '--button-count-probe': '1px' } }));
    const theme = { components: { Button: { vars } } };
    const tree = () => oneButton(build, theme);

    build.render(tree());
    expect(vars).toHaveBeenCalledTimes(3);

    vars.mockClear();
    setMantineUseStylesHoistGate(() => true);
    const html = build.render(tree());
    expect(vars).toHaveBeenCalledTimes(1);
    expect(html).toContain('--button-count-probe:1px');
  });

  it('a gate that answers anything but true keeps the original path', () => {
    const vars = vi.fn(() => ({ root: { '--button-count-probe': '1px' } }));
    const theme = { components: { Button: { vars } } };
    const tree = () => oneButton(build, theme);

    setMantineUseStylesHoistGate(() => false);
    build.render(tree());
    expect(vars).toHaveBeenCalledTimes(3);
  });
});
