# apps/creator-studio

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** — the shared conventions
for every SvelteKit app here (runes, derive-the-promise, keyed loops, form actions, `@civitai/ui`,
`text-dark-2`, placement, comments, the three review agents).

## Deltas

- **This app formats itself.** It is listed in the repo's `.prettierignore` and owns its formatting with
  its own **Prettier 3 + `prettier-plugin-svelte`**, run from this directory:

  ```bash
  pnpm -F @civitai/creator-studio-app format
  ```

  The root formatter is Prettier 2.8.8 and the two majors disagree about TypeScript (3 collapses
  leading-pipe unions that 2 breaks across lines), so ownership has to be exclusive or they fight over
  the same files forever. **Never run the root `prettier` over this directory**, and never run an ad-hoc
  `npx prettier --plugin=prettier-plugin-svelte` anywhere — outside this app's own configured script it
  empties `.svelte` files to zero bytes.
