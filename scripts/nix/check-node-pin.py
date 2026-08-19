#!/usr/bin/env python3
"""Assert the Nix devShell's node and pnpm agree with what the repo declares.

Scope, stated narrowly on purpose
---------------------------------
There are four independent declarations of "the Node version":

  .nvmrc                  what CI installs (every workflow uses
                          `actions/setup-node` with `node-version-file: .nvmrc`)
  Dockerfile FROM node:   what production actually runs
  package.json engines    the declared supported range
  flake.nix devShell      what a NixOS developer actually runs

The first three are already owned by `src/__tests__/node-version-consistency.test.ts`,
which checks them far more carefully than this script could (extractor controls,
two independent readers, fixture-driven predicates). This script deliberately does
NOT re-check that triangle -- a predicate open-coded at two sites is the way it
starts disagreeing with itself.

What this script owns is the FOURTH declaration, the one a Vitest suite cannot
reach because answering it means evaluating Nix: does the node the flake hands a
developer match the node the rest of the repo declares? `.nvmrc` is the authority,
because it is the one CI reads directly.

Run it via `nix flake check` or `nix run .#doctor`, or directly:

    python3 scripts/nix/check-node-pin.py \
      --nvmrc .nvmrc --package-json package.json \
      --flake-node 24.19.0 --flake-pnpm 10.34.5

Every failure is tagged with a stable id (N1..N3) so a test can assert that a
specific guard fired rather than merely that *something* failed.
"""

from __future__ import annotations

import argparse
import json
import sys

try:
    import nodesemver
except ImportError:  # pragma: no cover - only reachable outside the nix check
    sys.exit(
        "check-node-pin: the `nodesemver` module is missing. This script is meant to "
        "run inside the flake's check environment: `nix flake check`, or "
        "`nix run .#doctor`."
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--nvmrc", required=True)
    p.add_argument("--package-json", required=True)
    p.add_argument("--flake-node", required=True, help="node version the flake devShell provides")
    p.add_argument("--flake-pnpm", required=True, help="pnpm version the flake devShell provides")
    return p.parse_args()


def major(version: str) -> str:
    return version.split(".", 1)[0]


def main() -> int:
    args = parse_args()

    with open(args.nvmrc, encoding="utf-8") as fh:
        nvmrc = fh.read().strip()
    with open(args.package_json, encoding="utf-8") as fh:
        pkg = json.load(fh)

    engines_node = pkg.get("engines", {}).get("node")
    package_manager = pkg.get("packageManager")

    print("node/pnpm: flake vs repo")
    print(f"  .nvmrc                    {nvmrc}")
    print(f"  package.json engines.node {engines_node}")
    print(f"  package.json packageMgr   {package_manager}")
    print(f"  flake devShell node       {args.flake_node}")
    print(f"  flake devShell pnpm       {args.flake_pnpm}")
    print()

    failures: list[str] = []

    # N1 - the flake's node must satisfy the repo's own engines range. pnpm
    # enforces that range on install, so a flake outside it hands the developer a
    # shell that cannot install the project. This is the assertion that was
    # failing before the flake moved to node 24.
    if not engines_node:
        failures.append("N1: package.json has no engines.node; nothing to check the flake against")
    elif not nodesemver.satisfies(args.flake_node, engines_node, loose=False):
        failures.append(
            f"N1: flake devShell node {args.flake_node} does NOT satisfy "
            f"package.json engines.node {engines_node!r}"
        )

    # N2 - exact agreement with the authority. This is stable: nixpkgs is pinned
    # by flake.lock, so only a deliberate `nix flake update` can move it, and
    # when it does the remedy is a decision rather than a surprise at runtime.
    if args.flake_node != nvmrc:
        failures.append(
            f"N2: flake devShell node {args.flake_node} != .nvmrc {nvmrc}. "
            f"Either bump .nvmrc + Dockerfile to {args.flake_node} (CI and prod follow "
            f".nvmrc, and node-version-consistency.test.ts enforces that triangle), "
            f"or hold flake.lock at a nixpkgs rev whose nodejs_{major(nvmrc)} is {nvmrc}."
        )

    # N3 - pnpm major. nixpkgs will not carry the exact patch the packageManager
    # field names, and does not need to: the lockfile FORMAT is tied to the
    # major. A major mismatch rewrites pnpm-lock.yaml on the next install.
    if not package_manager or "@" not in package_manager:
        failures.append("N3: package.json has no usable packageManager field")
    else:
        declared = package_manager.rsplit("@", 1)[1]
        if major(args.flake_pnpm) != major(declared):
            failures.append(
                f"N3: flake devShell pnpm {args.flake_pnpm} is a different MAJOR than "
                f"package.json packageManager {package_manager!r}. A pnpm major bump "
                f"rewrites pnpm-lock.yaml."
            )
        elif args.flake_pnpm != declared:
            print(
                f"note: flake pnpm {args.flake_pnpm} != packageManager {declared} "
                f"(same major, lockfile format compatible - not an error)"
            )

    if failures:
        print("FAIL: the flake's toolchain disagrees with the repo", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1

    print("OK: the flake's node and pnpm agree with .nvmrc and package.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
