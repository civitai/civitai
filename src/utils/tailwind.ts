// The literal lives in `breakpoints.json` so that it stays single-sourced across two
// module systems: this ESM/TypeScript module (imported by app components) and the
// CommonJS `tailwind.config.js` (which `require()`s the same JSON). JSON is the one
// format Node's CJS resolver, jiti, webpack and Vite all load natively, so neither
// side needs a TypeScript-aware loader to read it.
//
// `resolveJsonModule` keeps the inferred type here identical to the old inline object
// literal (`{ xs: string; sm: string; md: string; lg: string; xl: string }`).
import breakpoints from './breakpoints.json';

export { breakpoints };
