#!/usr/bin/env python3
"""Assert the flake's hand-pinned Prisma engines match the lockfile's Prisma client.

Why this exists
---------------
`@prisma/client` embeds an engine commit hash and verifies it against the engine
binary it loads at runtime. nixpkgs does not carry every Prisma release (it
jumps 6.7 -> 6.18), so `flake.nix` fetches Prisma's official prebuilt engines for
one exact commit and points `PRISMA_QUERY_ENGINE_LIBRARY` & friends at them.

That makes the flake's `engineCommit` a hardcoded mirror of a value that lives in
`pnpm-lock.yaml`. `package.json` declares `@prisma/client: ^6.3.0` - a caret
range - so any lockfile refresh can move the resolved client while the flake's
engines stay pinned. Nothing would fail at build time; it fails at runtime, in
every developer's shell, with an engine-mismatch error.

This check closes that loop by re-deriving both values from the lockfile and
comparing them to what the flake passes in.

Run via `nix flake check`, or directly:

    python3 scripts/nix/check-prisma-pin.py \
      --package-json package.json --lockfile pnpm-lock.yaml \
      --flake-prisma-version 6.13.0 \
      --flake-engine-commit 361e86d0ea4987e9f53a565309b3eed797a6bcbd

Failures are tagged P1..P4 so a test can assert which guard fired.
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    import yaml
except ImportError:  # pragma: no cover - only reachable outside the nix check
    sys.exit(
        "check-prisma-pin: the `yaml` module is missing. This script is meant to run "
        "inside the flake's check environment: `nix flake check`, or `nix run .#doctor`."
    )

try:
    Loader = yaml.CSafeLoader
except AttributeError:  # pragma: no cover
    Loader = yaml.SafeLoader

ROOT_IMPORTER = "."


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--package-json", required=True)
    p.add_argument("--lockfile", required=True)
    p.add_argument("--flake-prisma-version", required=True)
    p.add_argument("--flake-engine-commit", required=True)
    return p.parse_args()


def bare_version(resolved: str) -> str:
    """`6.13.0(prisma@6.13.0(typescript@5.9.2))(typescript@5.9.2)` -> `6.13.0`."""
    return resolved.split("(", 1)[0]


def main() -> int:
    args = parse_args()

    with open(args.package_json, encoding="utf-8") as fh:
        pkg = json.load(fh)
    with open(args.lockfile, encoding="utf-8") as fh:
        lock = yaml.load(fh, Loader=Loader)

    declared_range = pkg.get("dependencies", {}).get("@prisma/client")
    importers = lock.get("importers", {})
    snapshots = lock.get("snapshots", {})

    failures: list[str] = []

    root = importers.get(ROOT_IMPORTER)
    if root is None:
        print(
            f"FAIL: pnpm-lock.yaml has no {ROOT_IMPORTER!r} importer - the lockfile "
            f"shape changed and this guard is no longer measuring anything",
            file=sys.stderr,
        )
        return 1

    client_entry = root.get("dependencies", {}).get("@prisma/client")
    cli_entry = root.get("devDependencies", {}).get("prisma")
    if client_entry is None:
        print(
            "FAIL: pnpm-lock.yaml root importer has no @prisma/client dependency",
            file=sys.stderr,
        )
        return 1

    locked_client = bare_version(client_entry["version"])
    locked_cli = bare_version(cli_entry["version"]) if cli_entry else None

    # The engine commit is not stored on the client package; it is the version
    # suffix of the @prisma/engines-version package that @prisma/engines@<v>
    # depends on. Derive it rather than trusting a second hardcoded copy.
    engines_key = f"@prisma/engines@{locked_client}"
    engines_snapshot = snapshots.get(engines_key)
    locked_engine_commit = None
    engines_version = None
    if engines_snapshot is not None:
        engines_version = engines_snapshot.get("dependencies", {}).get("@prisma/engines-version")
        if engines_version and "." in engines_version:
            # `6.13.0-35.361e86d0...` -> `361e86d0...`
            locked_engine_commit = engines_version.rsplit(".", 1)[1]

    print("prisma engine pin")
    print(f"  package.json @prisma/client range   {declared_range}")
    print(f"  pnpm-lock @prisma/client resolved   {locked_client}")
    print(f"  pnpm-lock prisma (CLI) resolved     {locked_cli}")
    print(f"  pnpm-lock @prisma/engines-version   {engines_version}")
    print(f"  pnpm-lock engine commit             {locked_engine_commit}")
    print(f"  flake.nix prismaVersion             {args.flake_prisma_version}")
    print(f"  flake.nix engineCommit              {args.flake_engine_commit}")
    print()

    # P1 - the flake downloads engines for one exact client version.
    if locked_client != args.flake_prisma_version:
        failures.append(
            f"P1: pnpm-lock.yaml resolves @prisma/client to {locked_client} but flake.nix "
            f"pins prisma-engines to {args.flake_prisma_version}. package.json declares the "
            f"caret range {declared_range!r}, so a lockfile refresh moved the client without "
            f"the flake following. Update prismaVersion, engineCommit and all three sha256s "
            f"in flake.nix together."
        )

    # P2 - the engine commit is what @prisma/client verifies at runtime.
    if locked_engine_commit is None:
        failures.append(
            f"P2: could not derive an engine commit from pnpm-lock.yaml. Expected a "
            f"snapshot {engines_key!r} with a @prisma/engines-version dependency; this guard "
            f"is no longer measuring anything."
        )
    elif locked_engine_commit != args.flake_engine_commit:
        failures.append(
            f"P2: pnpm-lock.yaml engine commit {locked_engine_commit} != flake.nix "
            f"engineCommit {args.flake_engine_commit}. The engine binaries the flake exports "
            f"via PRISMA_QUERY_ENGINE_LIBRARY would be rejected by @prisma/client at runtime."
        )

    # P3 - the CLI (`prisma generate`, `prisma migrate`) uses the schema-engine
    # binary the flake exports, so it must be the same version as the client.
    if locked_cli is None:
        failures.append("P3: pnpm-lock.yaml root importer has no `prisma` devDependency")
    elif locked_cli != locked_client:
        failures.append(
            f"P3: pnpm-lock.yaml resolves the prisma CLI to {locked_cli} but @prisma/client "
            f"to {locked_client}; the flake exports one schema-engine for both."
        )

    if failures:
        print("FAIL: prisma engine pin has drifted", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1

    print("OK: flake prisma-engines pin matches the lockfile's resolved @prisma/client")
    return 0


if __name__ == "__main__":
    sys.exit(main())
