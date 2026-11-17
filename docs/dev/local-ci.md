# CI runs on CI, not on this workstation

The GitHub Actions workflows (`.github/workflows/`: `apps`, `lint`, `full-ci`,
`moderator-boot`, `schema-drift`, `submodule-pin-guard`, `trpc-server-parity`) are
where a change is validated. Do **not** run the whole local mirror
(`scripts/ci/*.mjs` across the workspace) to "reproduce CI" — this is a large
monorepo and a workspace-wide run spins the disks and slows every agent and the
operator's desktop. Workspace-wide `turbo` task runs and recursive
`pnpm`/`npm`/`yarn` (`-r` / `--recursive` / `--workspaces`) are refused by the
local agent tooling.

**A change-scoped subset is the local loop** — one app's suite
(`pnpm --filter <app> test`), one `scripts/ci/*.mjs` gate directly, or a single
package's typecheck. The full workspace is CI's.
