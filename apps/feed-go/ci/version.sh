#!/bin/sh
# Prints the feed-go release: the "version" of apps/feed-go/package.json (the file
# scripts/release-app.mjs bumps before it cuts the feed-go-vX.Y.Z tag). The Dockerfile passes it to
# `-ldflags -X main.version`, so the deployed binary's `--version` and its X-Feed-Go-Version header
# name the release instead of "dev". POSIX sh and sed only: it runs in the golang alpine build stage,
# which has no jq or node.
#
# Usage: ci/version.sh [path/to/package.json]   (default: ./package.json)
set -eu
file=${1:-package.json}
v=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9A-Za-z.+-]*\)",\{0,1\}[[:space:]]*$/\1/p' "$file")
case $v in
'' | *"
"*)
	echo "ci/version.sh: want exactly one \"version\" line in $file, got: '$v'" >&2
	exit 1
	;;
esac
printf '%s\n' "$v"
