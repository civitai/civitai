// `query-string@7` is CJS *and* ships no `main`/`exports` in its package.json, so
// Vite's dep optimizer hands back a module without named exports and anything
// doing `import { parse } from 'query-string'` (src/utils/qs.ts) fails to load.
// Next/webpack resolves it fine, so this is a Ladle-only interop patch — aliased
// in .ladle/vite.config.ts and never part of the app build.
//
// Importing the file path directly (not the bare specifier) sidesteps the alias,
// and a CJS file's `module.exports` arrives as the default import.
import queryString from 'query-string/index.js';

export const { extract, parse, stringify, parseUrl, stringifyUrl, pick, exclude } = queryString;
export default queryString;
