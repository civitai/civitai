# Releasing the auth hub

The auth hub (`apps/auth`, deployed at **auth.civitai.com**) ships as its own image,
`ghcr.io/civitai/civitai-auth`, on its own version stream — independent of the main
`civitai-web` release. This mirrors the main app's `pnpm run release` ergonomics with a
parallel `release:auth` family of scripts.

## Prerequisites

- Run from a checkout that is **on `main`** with a **clean working tree**. The release script
  refuses to run otherwise (it commits + tags the bump onto `main` and pushes it).
- You must have **push access to `main`** (it is a protected branch with a push allowlist). The
  final `git push` lands the bump commit + tag directly on `main`; if you cannot push to `main`
  the push will be rejected — see *If the push fails* below.

## How to cut a release

From the repo root:

```bash
pnpm run release:auth          # patch (default) — most common
pnpm run release:auth:minor    # minor
pnpm run release:auth:major    # major
```

Each script runs `scripts/release-app.mjs apps/auth auth-app-v <bump>`, which:

1. verifies you are on `main` with a clean tree, then `git pull --rebase`,
2. bumps **only** `apps/auth/package.json` (`npm version --no-git-tag-version`; the root
   `package.json` is untouched),
3. commits **only** `apps/auth/package.json` and creates an annotated tag **`auth-app-vX.Y.Z`**,
4. `git push --follow-tags` — pushes the commit + the new tag.

> The script does the commit/tag explicitly rather than via `npm version`'s built-in git step:
> in this monorepo `.git` is at the **root**, and `npm --prefix apps/auth version` would
> *silently skip* the commit + tag (it only creates them when `.git` lives in the package dir).

Unlike the main app's `release`, this flow does **not** touch the `release` branch — the hub
deploys straight off the tag via ghcr + Flux (see below), so there is no `release:base` step.

Release **one app at a time** (concurrent releases race on the `main` push).

## If the push fails

If `git push` is rejected (no `main` access, or `main` advanced mid-release), the commit + tag
were created **locally** but not pushed. Undo and retry from a clean state:

```bash
git tag -d auth-app-vX.Y.Z      # the version it printed
git reset --hard origin/main
```

then re-run the release (ideally as someone with `main` push access).

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
