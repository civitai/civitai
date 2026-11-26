---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---

# Import cycles

- A new import must not join or merge an import cycle. `no-import-cycle-growth` and
  `no-image-service-import-cycle` cap them, but they run in the unit suite, which runs on `main`
  after merge, not on a PR, so a PR that adds a cycle turns `main` red later. Run both before pushing
  any change that adds an import between `src/server/services` modules or into a registry or barrel:
  `pnpm exec vitest run --project 'unit*' src/server/services/__tests__/no-import-cycle-growth.test.ts src/server/services/__tests__/no-image-service-import-cycle.test.ts`.
- A call-site `await import()` or `next/dynamic` is not a cut: the guards count dynamic imports.
  Move the shared piece into its own module, import the one module you need instead of a registry
  or barrel, or have the caller pass the dependency in.
- How to find and break a cycle: `docs/dev/import-cycles.md`.
