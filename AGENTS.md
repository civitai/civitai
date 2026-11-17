# Agent instructions

Read `CLAUDE.md` first; it is binding for all agents, including its security section (this repository is
public). The block below is written by `next dev` and only covers the Next.js version; keep this header
above it, since `next dev` rewrites only the text between its markers.

## Endpoints ported to Go

- `ports/manifest.json` lists every endpoint ported from Node to a Go service (`apps/feed-go`,
  `apps/beacon-go`) and its lifecycle stage. `ports/README.md` explains the stages and fields.
- Before changing Node code, run `node scripts/ports/touched.mjs <files>` (or `--base origin/main`)
  to see which ports it touches. A `@ported-to-go` comment above a symbol marks a port's entry.
- For each port it touches, read the port's manifest entry. If the change alters what the endpoint
  returns, change its Go handler (`goHandler`) in the same PR, so Node and Go still answer the same.
- Never hand-edit a `@ported-to-go` block. Edit the manifest, run
  `node scripts/ports/generate.mjs`, and commit what it writes; CI (`ports.yml`) fails when the
  manifest is invalid or a marker is stale. The ports' dependency lists are not stored:
  `touched.mjs` computes them from source each run (Go on `PATH` for the Go half).
- The manifest is the intended stage, not live routing: it does not read flag values.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
