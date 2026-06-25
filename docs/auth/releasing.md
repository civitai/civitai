# Releasing the auth hub

The auth hub (`apps/auth`, deployed at **auth.civitai.com**) ships as its own image,
`ghcr.io/civitai/civitai-auth`, on its own version stream — independent of the main
`civitai-web` release. This mirrors the main app's `pnpm run release` ergonomics with a
parallel `release:auth` family of scripts.

## How to cut a release

From the repo root:

```bash
pnpm run release:auth          # patch (default) — most common
pnpm run release:auth:minor    # minor
pnpm run release:auth:major    # major
```

Each script:

1. `git pull` (so the tag lands on top of the latest `main`),
2. `npm --prefix apps/auth version <bump> --tag-version-prefix=auth-app-v` — bumps **only**
   `apps/auth/package.json` (the root `package.json` is untouched) and creates an annotated
   git tag named **`auth-app-vX.Y.Z`**,
3. `git push --follow-tags` — pushes the commit + the new tag.

Unlike the main app's `release`, this flow does **not** touch the `release` branch — the hub
deploys straight off the tag via ghcr + Flux (see below), so there is no `release:base` step.

## What happens after the push

```
git tag auth-app-vX.Y.Z (pushed)
        │
        ▼
in-cluster Tekton `tag-webhook` receiver  ──fires on `auth-app-v*` tags
        │  builds apps/auth/Dockerfile (context = repo root)
        ▼
ghcr.io/civitai/civitai-auth:X.Y.Z
        │
        ▼
Flux (datapacket-talos repo)  ──ImageRepository scans ghcr → ImagePolicy picks the
        │                       highest semver → ImageUpdateAutomation bumps the tag on
        │                       trunk → Flux reconciles
        ▼
auth-hub Deployment rolls out the new image
```

GitHub Actions is **not** used for the hub build (it is a paid runner and would double-build
on the same tag). The image build runs entirely in-cluster on Tekton.

## Versioning notes

- The deployed hub started at `0.1.0` (a tag was cut manually before this flow existed), and
  `apps/auth/package.json` is synced to `0.1.0`. The first scripted release is therefore
  `pnpm run release:auth` → **`0.1.1`**. (Starting from `0.0.0` would have produced `0.0.1`,
  which is *lower* than the deployed `0.1.0`, and Flux's highest-semver ImagePolicy would
  ignore it.)
- Flux selects images by **highest semver**, so never hand-push a tag lower than what is
  already deployed.

## Tag convention (per-app)

The `auth-app-v` prefix scopes releases to this app so multiple apps can live in the monorepo
without colliding on a shared `v*` tag namespace (which belongs to the main `civitai-web`
release). Future spun-out apps should follow the same pattern: pick a `<app>-vX.Y.Z` prefix,
wire a Tekton `tag-webhook` trigger on that prefix, and add a parallel `release:<app>` script
family to the root `package.json`.
