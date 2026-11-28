/**
 * A staff platform update that bumps three platform packages, and an owner's bundle that has
 * them plus later, unrelated dev-only bumps: a `package.json` and a realistic pnpm v9 lockfile
 * (importers, packages, snapshots, peer suffixes) for each. Shared by the containment and
 * bundle-check tests.
 */

export type Versions = {
  sdk: string;
  blocksReact: string;
  appSdk: string;
  cli: string;
  vite: string;
  vitest: string;
  eslint: string;
};

/** The update's base: older platform packages. Every version below is distinct from every other. */
export const BASE_V: Versions = {
  sdk: '0.33.0',
  blocksReact: '0.87.2',
  appSdk: '0.95.1',
  cli: '1.40.3',
  vite: '6.0.5',
  vitest: '3.0.4',
  eslint: '9.10.0',
};
/** The staff update: the three platform packages, nothing else. */
export const UPDATE_V: Versions = {
  ...BASE_V,
  sdk: '0.34.0',
  blocksReact: '0.88.0',
  appSdk: '0.96.0',
};
/** The owner's bundle: the update's three, plus later dev-only bumps the update never made. */
export const OWNER_V: Versions = {
  ...UPDATE_V,
  cli: '1.42.1',
  vite: '6.2.7',
  vitest: '3.1.9',
  eslint: '9.12.6',
};

export const packageJson = (v: Versions, extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      name: 'fixture-app',
      private: true,
      type: 'module',
      scripts: { build: 'vite build', test: 'vitest run' },
      dependencies: {
        '@civitai/app-sdk': `^${v.appSdk}`,
        '@civitai/blocks-react': `^${v.blocksReact}`,
        '@civitai/sdk': v.sdk,
        react: '^19.0.0',
      },
      devDependencies: {
        '@civitai/cli': `^${v.cli}`,
        eslint: `^${v.eslint}`,
        vite: `^${v.vite}`,
        vitest: `^${v.vitest}`,
      },
      ...extra,
    },
    null,
    2
  ) + '\n';

/** A stand-in integrity hash that moves with the version, as a real one does. */
const integrity = (id: string) =>
  `sha512-${Buffer.from(id).toString('base64').replace(/=+$/, '')}==`;

/** A pnpm v9 lockfile for `packageJson(v)`: importers, packages and snapshots. */
export function pnpmLock(v: Versions): string {
  const blocksReact = `${v.blocksReact}(react@19.0.0)(vite@${v.vite})`;
  const appSdk = `${v.appSdk}(react@19.0.0)`;
  const entry = (name: string, spec: string, version: string) => [
    `      '${name}':`,
    `        specifier: ${spec}`,
    `        version: ${version}`,
  ];
  const pkgs: Array<[string, string]> = [
    ['@civitai/app-sdk', v.appSdk],
    ['@civitai/blocks-react', v.blocksReact],
    ['@civitai/cli', v.cli],
    ['@civitai/sdk', v.sdk],
    ['eslint', v.eslint],
    ['react', '19.0.0'],
    ['vite', v.vite],
    ['vitest', v.vitest],
  ];
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    ...entry('@civitai/app-sdk', `^${v.appSdk}`, appSdk),
    ...entry('@civitai/blocks-react', `^${v.blocksReact}`, blocksReact),
    ...entry('@civitai/sdk', v.sdk, v.sdk),
    ...entry('react', '^19.0.0', '19.0.0'),
    '    devDependencies:',
    ...entry('@civitai/cli', `^${v.cli}`, v.cli),
    ...entry('eslint', `^${v.eslint}`, v.eslint),
    ...entry('vite', `^${v.vite}`, v.vite),
    ...entry('vitest', `^${v.vitest}`, `${v.vitest}(vite@${v.vite})`),
    '',
    'packages:',
    '',
    ...pkgs.flatMap(([name, version]) => [
      `  '${name}@${version}':`,
      `    resolution: {integrity: ${integrity(`${name}@${version}`)}}`,
      "    engines: {node: '>=18'}",
      '',
    ]),
    'snapshots:',
    '',
    `  '@civitai/app-sdk@${appSdk}':`,
    '    dependencies:',
    '      react: 19.0.0',
    '',
    `  '@civitai/blocks-react@${blocksReact}':`,
    '    dependencies:',
    '      react: 19.0.0',
    `      vite: ${v.vite}`,
    '',
    `  '@civitai/cli@${v.cli}': {}`,
    '',
    `  '@civitai/sdk@${v.sdk}': {}`,
    '',
    `  eslint@${v.eslint}: {}`,
    '',
    '  react@19.0.0: {}',
    '',
    `  vite@${v.vite}: {}`,
    '',
    `  vitest@${v.vitest}(vite@${v.vite}):`,
    '    dependencies:',
    `      vite: ${v.vite}`,
    '',
  ].join('\n');
}

/** pnpm 11+: a boot document (pnpm's own version) before the project document. */
export const twoDocuments = (project: string) =>
  [
    '---',
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    configDependencies: {}',
    '    packageManagerDependencies:',
    '      pnpm:',
    '        specifier: 11.0.2',
    '        version: 11.0.2',
    '',
    'packages:',
    '',
    '  pnpm@11.0.2:',
    '    resolution: {integrity: sha512-boot==}',
    '',
    '---',
    project,
  ].join('\n');
