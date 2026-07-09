# Auth hub CI — `ghcr.io/civitai/civitai-auth`

The login hub (`apps/auth`) is built + published by
[`.github/workflows/auth-app.yml`](../../../.github/workflows/auth-app.yml). This is the
first per-app CI in the monorepo.

## Approach: GitHub Actions → ghcr (not Tekton)

Decided by evidence, not default:

- **The main civitai-web image is built by Tekton** (`tekton.civitai.com`), and the only
  workflow on `origin/main` is `submodule-pin-guard.yml` — a guard, it builds no image. So
  there is no in-repo Actions image-build to extend or imitate from the main app.
- **The sibling apps build via GitHub Actions → ghcr:** `civitai/civitai-chat`
  (`ci.yml`: buildx + `type=gha` cache, semver from `package.json`, push on `main`) and
  `civitai/civitai-image-cacher` (`main.yml`: push on `v*` **tags**). Both publish straight to
  ghcr with the built-in `GITHUB_TOKEN`.
- **Flux already consumes ghcr semver.** datapacket-talos has an `ImagePolicy` (semver
  `>=0.0.1`) + `ImageUpdateAutomation` watching `ghcr.io/civitai/civitai-auth`. An Actions
  workflow that pushes a clean semver tag is self-contained and slots directly into that
  existing mechanism — no Tekton pipeline/trigger wiring, no new secrets.

Tekton would mean standing up a Pipeline + trigger + dashboard exposure for one small app,
duplicating what the sibling apps already do far more simply. The evidence favors Actions.

## Trigger + tag scheme

| Event | Builds? | Pushes? |
|---|---|---|
| PR touching `apps/auth/**`, `packages/**`, lockfile, `patches/**`, the workflow | yes | **no** (compile gate) |
| Push of a tag `auth-app-v*` (e.g. `auth-app-v0.1.0`) | yes | yes |
| `workflow_dispatch` from a `auth-app-v*` tag ref | yes | yes |
| `workflow_dispatch` from a branch | yes | no |

The **`auth-app-v` prefix** scopes releases to this app, so other monorepo apps can adopt
their own prefix (e.g. `chat-app-v`) without fighting over a shared `v*` tag namespace.
The semver is derived from the tag (`auth-app-v0.1.0` → `0.1.0`), validated against
`^\d+\.\d+\.\d+([-+].+)?$`. The app's `package.json` version is `0.0.0` and is intentionally
**not** the source of truth — the git tag is.

## Image tags pushed

On a release tag, two tags are pushed:

- `ghcr.io/civitai/civitai-auth:<semver>` — what Flux's ImagePolicy selects.
- `ghcr.io/civitai/civitai-auth:sha-<short>` — provenance / pinning.

**No `:latest`** from a tag build. `:latest` is a moving pointer; with Flux image automation
on the same repo it risks auto-deploying an unintended digest. Flux selects by semver, so
`:latest` adds nothing here.

## Build details

- Context = **repo root**; `file: apps/auth/Dockerfile`. The Dockerfile COPYs
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`, `patches/`, `packages/`, and
  `apps/auth/package.json` — all relative to root, so the context must be root (matches the
  documented `docker build -f apps/auth/Dockerfile .`).
- `platforms: linux/amd64` (the cluster is amd64).
- docker buildx + GitHub Actions cache (`cache-from/to: type=gha`).
- `permissions: { contents: read, packages: write }`; ghcr login uses the built-in
  `GITHUB_TOKEN` only on push runs.

## What a release looks like

```bash
# from the default branch, at the commit you want to ship:
git tag auth-app-v0.1.0
git push origin auth-app-v0.1.0
```

1. Actions builds `apps/auth/Dockerfile` and pushes
   `ghcr.io/civitai/civitai-auth:0.1.0` (+ `:sha-<short>`).
2. Flux's `ImageRepository` scans ghcr (1–5 min); the `ImagePolicy` (semver `>=0.0.1`) picks
   `0.1.0` as the newest.
3. `ImageUpdateAutomation` commits the bumped tag to `trunk` in datapacket-talos.
4. Flux applies; the auth-hub Deployment rolls out the new image.

## Status

Workflow authored and **actionlint-clean**. It is **not** run-verified — GitHub Actions
cannot run locally, and tag-triggered workflows only execute once the workflow file is on the
**default branch**. First real run happens after this merges (via PR #2468 →) `main`, then on
the first `auth-app-v*` tag push. The underlying Docker build is already proven (the live
`0.0.1` image was built from this exact Dockerfile + root context).
