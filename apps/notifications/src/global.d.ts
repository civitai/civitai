// The shared @civitai/* packages (e.g. @civitai/axiom) reference the monolith's ambient `MixedObject`
// global in their raw-TS source. The monolith declares it in src/types/global.d.ts; a standalone app
// that bundles those packages needs its own copy so `tsc`/`tsup` can resolve the name.
declare global {
  type MixedObject = Record<string, any>;
}

export {};
