import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Pins `patches/@mantine__core@7.17.8.patch`. Every Mantine `Box` (so nearly every element a
 * page renders) runs `extractStyleProps`, `parseStyleProps` and, through `useProps`,
 * `filterProps`. Unpatched, the first destructures all 54 style-prop names and rebuilds `rest`
 * with an object rest spread, the second runs a reduce and a media-query sort even when there is
 * nothing to parse, and the third is a reduce. The patch makes them one loop each and returns
 * early from `parseStyleProps` when there are no style props.
 *
 * The output must not change, key ORDER included: `parseStyleProps` writes inline styles in
 * `styleProps` order, so `{ mt, m }` must still become `margin` then `marginTop`. The reference
 * implementations below are verbatim copies of the unpatched 7.17.8 functions. Both builds are
 * checked (`esm/` and `cjs/`), because which one SSR loads depends on the bundler.
 *
 * 🔴 If a test here fails after a Mantine upgrade, the patch no longer applies to the code it was
 * written for: re-read these three functions in the new version, regenerate the patch or drop it,
 * and update `package.json` → `pnpm.patchedDependencies`.
 */

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
// `@mantine/core` does not export `./package.json`; its main entry is `cjs/index.cjs`.
const MANTINE = join(dirname(requireFromRepo.resolve('@mantine/core')), '..');
const FILES = {
  extract: 'core/Box/style-props/extract-style-props/extract-style-props',
  parse: 'core/Box/style-props/parse-style-props/parse-style-props',
  filter: 'core/utils/filter-props/filter-props',
  sortMediaQueries: 'core/Box/style-props/parse-style-props/sort-media-queries',
  resolvers: 'core/Box/style-props/resolvers/index',
  data: 'core/Box/style-props/style-props-data',
  theme: 'core/MantineProvider/default-theme',
};

type Props = Record<string, unknown>;
type Parsed = {
  hasResponsiveStyles: boolean;
  styles: Props;
  inlineStyles: Props;
  media: { query: string; styles: Props }[];
};
type ParseArgs = { styleProps: Props; data: Props; theme: Theme };
type Theme = { breakpoints: Record<string, string> };
type Impl = {
  extractStyleProps: (others: Props) => { styleProps: Props; rest: Props };
  parseStyleProps: (args: ParseArgs) => Parsed;
  filterProps: (props: Props) => Props;
};

async function loadBuild(build: 'esm' | 'cjs'): Promise<Impl> {
  const load = async (rel: string) =>
    build === 'esm'
      ? ((await import(pathToFileURL(join(MANTINE, 'esm', `${rel}.mjs`)).href)) as Props)
      : (requireFromRepo(join(MANTINE, 'cjs', `${rel}.cjs`)) as Props);
  return {
    extractStyleProps: (await load(FILES.extract)).extractStyleProps as Impl['extractStyleProps'],
    parseStyleProps: (await load(FILES.parse)).parseStyleProps as Impl['parseStyleProps'],
    filterProps: (await load(FILES.filter)).filterProps as Impl['filterProps'],
  };
}

const { sortMediaQueries } = requireFromRepo(
  join(MANTINE, 'cjs', `${FILES.sortMediaQueries}.cjs`)
) as {
  sortMediaQueries: (acc: unknown) => Parsed;
};
const { resolvers } = requireFromRepo(join(MANTINE, 'cjs', `${FILES.resolvers}.cjs`)) as {
  resolvers: Record<string, (value: unknown, theme: Theme) => unknown>;
};
const { STYlE_PROPS_DATA: data } = requireFromRepo(join(MANTINE, 'cjs', `${FILES.data}.cjs`)) as {
  STYlE_PROPS_DATA: Record<string, { type: string; property: string | string[] }>;
};
const { DEFAULT_THEME: theme } = requireFromRepo(join(MANTINE, 'cjs', `${FILES.theme}.cjs`)) as {
  DEFAULT_THEME: Theme;
};

// ---- Unpatched @mantine/core 7.17.8, verbatim (types added) --------------------------------

function originalFilterProps(props: Props) {
  return Object.keys(props).reduce((acc: Props, key) => {
    if (props[key] !== void 0) {
      acc[key] = props[key];
    }
    return acc;
  }, {});
}

function originalExtractStyleProps(others: Props) {
  const {
    m,
    mx,
    my,
    mt,
    mb,
    ml,
    mr,
    me,
    ms,
    p,
    px,
    py,
    pt,
    pb,
    pl,
    pr,
    pe,
    ps,
    bd,
    bg,
    c,
    opacity,
    ff,
    fz,
    fw,
    lts,
    ta,
    lh,
    fs,
    tt,
    td,
    w,
    miw,
    maw,
    h,
    mih,
    mah,
    bgsz,
    bgp,
    bgr,
    bga,
    pos,
    top,
    left,
    bottom,
    right,
    inset,
    display,
    flex,
    hiddenFrom,
    visibleFrom,
    lightHidden,
    darkHidden,
    sx,
    ...rest
  } = others;
  const styleProps = originalFilterProps({
    m,
    mx,
    my,
    mt,
    mb,
    ml,
    mr,
    me,
    ms,
    p,
    px,
    py,
    pt,
    pb,
    pl,
    pr,
    pe,
    ps,
    bd,
    bg,
    c,
    opacity,
    ff,
    fz,
    fw,
    lts,
    ta,
    lh,
    fs,
    tt,
    td,
    w,
    miw,
    maw,
    h,
    mih,
    mah,
    bgsz,
    bgp,
    bgr,
    bga,
    pos,
    top,
    left,
    bottom,
    right,
    inset,
    display,
    flex,
    hiddenFrom,
    visibleFrom,
    lightHidden,
    darkHidden,
    sx,
  });
  return { styleProps, rest };
}

function hasResponsiveStyles(styleProp: unknown) {
  if (typeof styleProp !== 'object' || styleProp === null) {
    return false;
  }
  const breakpoints = Object.keys(styleProp);
  if (breakpoints.length === 1 && breakpoints[0] === 'base') {
    return false;
  }
  return true;
}
function getBaseValue(value: unknown) {
  if (typeof value === 'object' && value !== null) {
    if ('base' in value) {
      return (value as Props).base;
    }
    return void 0;
  }
  return value;
}
function getBreakpointKeys(value: unknown) {
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).filter((key) => key !== 'base');
  }
  return [];
}
function getBreakpointValue(value: unknown, breakpoint: string) {
  if (typeof value === 'object' && value !== null && breakpoint in value) {
    return (value as Props)[breakpoint];
  }
  return value;
}
function originalParseStyleProps({ styleProps, theme }: ParseArgs) {
  return sortMediaQueries(
    Object.keys(styleProps).reduce(
      (
        acc: {
          hasResponsiveStyles: boolean;
          styles: Props;
          inlineStyles: Props;
          media: Record<string, Props>;
        },
        styleProp
      ) => {
        if (styleProp === 'hiddenFrom' || styleProp === 'visibleFrom' || styleProp === 'sx') {
          return acc;
        }
        const propertyData = data[styleProp];
        const properties = Array.isArray(propertyData.property)
          ? propertyData.property
          : [propertyData.property];
        const baseValue = getBaseValue(styleProps[styleProp]);
        if (!hasResponsiveStyles(styleProps[styleProp])) {
          properties.forEach((property) => {
            acc.inlineStyles[property] = resolvers[propertyData.type](baseValue, theme);
          });
          return acc;
        }
        acc.hasResponsiveStyles = true;
        const breakpoints = getBreakpointKeys(styleProps[styleProp]);
        properties.forEach((property) => {
          if (baseValue) {
            acc.styles[property] = resolvers[propertyData.type](baseValue, theme);
          }
          breakpoints.forEach((breakpoint) => {
            const bp = `(min-width: ${theme.breakpoints[breakpoint]})`;
            acc.media[bp] = {
              ...acc.media[bp],
              [property]: resolvers[propertyData.type](
                getBreakpointValue(styleProps[styleProp], breakpoint),
                theme
              ),
            };
          });
        });
        return acc;
      },
      { hasResponsiveStyles: false, styles: {}, inlineStyles: {}, media: {} }
    )
  );
}

// ---- Prop shapes ----------------------------------------------------------------------------

const symbolKey = Symbol('key');
const onClick = () => undefined;

// Every style prop, each with a value its resolver accepts. `lightHidden`/`darkHidden` are
// destructured by Box before it calls these functions, so they never reach parseStyleProps;
// the extract/filter cases still carry them.
const allStyleProps: Props = { ...Object.fromEntries(Object.keys(data).map((k) => [k, 'xs'])) };
Object.assign(allStyleProps, { hiddenFrom: 'sm', visibleFrom: 'md', sx: { color: 'red' } });

const SHAPES: Record<string, Props> = {
  'no props': {},
  'no style props': { children: 'x', onClick, 'aria-label': 'Open', 'data-testid': undefined },
  'a few style props': { children: 'z', mt: 'xs', c: 'dimmed', fz: 'sm' },
  // Inline styles follow styleProps order: margin must still precede marginTop.
  'style props in reverse of the canonical order': {
    mt: 'xs',
    m: 'md',
    pl: 4,
    p: 'lg',
    children: 'r',
  },
  'responsive objects': {
    p: { base: 'xs', md: 'md' },
    w: { sm: 100, lg: '50%' },
    display: { base: 'none', md: 'block' },
    m: { base: 'sm' },
  },
  // 0 and '' are defined values and must survive; undefined ones must not.
  'undefined, zero and empty values': {
    m: undefined,
    p: undefined,
    mt: 0,
    c: '',
    children: undefined,
    id: 'u',
  },
  'all style props': allStyleProps,
  'all style props mixed with non-style props': {
    1: 'one',
    className: 'c',
    ...allStyleProps,
    style: { color: 'blue' },
    href: '/a',
    0: 'zero',
    lightHidden: true,
    darkHidden: false,
  },
  'only the props parseStyleProps skips': {
    hiddenFrom: 'sm',
    visibleFrom: 'md',
    sx: { color: 'red' },
  },
  'a symbol key': { [symbolKey]: 'v', mt: 'xs', children: 'y' } as Props,
  'an own __proto__ key': JSON.parse(
    '{"__proto__": {"polluted": true}, "mt": "xs", "id": "p"}'
  ) as Props,
};

/** Order-preserving view (string keys, then symbols) that also keeps `undefined` values. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object') {
    return Reflect.ownKeys(value).map((key) => [
      String(key),
      ordered((value as Record<PropertyKey, unknown>)[key]),
    ]);
  }
  return value === undefined ? '<undefined>' : value;
}

function expectSame(patched: unknown, original: unknown) {
  expect(ordered(patched)).toEqual(ordered(original));
  expect(patched).toStrictEqual(original);
}

const withoutBoxOnlyProps = (styleProps: Props) =>
  Object.fromEntries(
    Object.entries(styleProps).filter(([key]) => key !== 'lightHidden' && key !== 'darkHidden')
  );

describe.each(['esm', 'cjs'] as const)('patched @mantine/core style props (%s)', (build) => {
  it('the mixed shape carries all 54 style props', () => {
    const mixed = SHAPES['all style props mixed with non-style props'];
    expect(Object.keys(originalExtractStyleProps(mixed).styleProps)).toHaveLength(54);
  });

  it.each(Object.entries(SHAPES))('%s', async (_name, props) => {
    const impl = await loadBuild(build);

    const patched = impl.extractStyleProps(props);
    const original = originalExtractStyleProps(props);
    expectSame(patched, original);

    const args = (styleProps: Props) => ({
      styleProps: withoutBoxOnlyProps(styleProps),
      data,
      theme,
    });
    expectSame(
      impl.parseStyleProps(args(patched.styleProps)),
      originalParseStyleProps(args(original.styleProps))
    );

    expectSame(impl.filterProps(props), originalFilterProps(props));
  });

  it('returns fresh objects from the no-style-props early return', async () => {
    const impl = await loadBuild(build);
    const a = impl.parseStyleProps({ styleProps: {}, data, theme });
    a.inlineStyles.color = 'red';
    a.media.push({ query: 'x', styles: {} });
    expectSame(
      impl.parseStyleProps({ styleProps: {}, data, theme }),
      originalParseStyleProps({ styleProps: {}, data, theme })
    );
  });
});
