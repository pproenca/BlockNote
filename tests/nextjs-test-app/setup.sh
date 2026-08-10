#!/bin/bash

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARBALLS_DIR="$SCRIPT_DIR/.tarballs"

: "${BLOCKNOTE_CORE_TARBALL:?Missing BLOCKNOTE_CORE_TARBALL}"
: "${BLOCKNOTE_REACT_TARBALL:?Missing BLOCKNOTE_REACT_TARBALL}"
: "${BLOCKNOTE_SERVER_UTIL_TARBALL:?Missing BLOCKNOTE_SERVER_UTIL_TARBALL}"
: "${BLOCKNOTE_COLLABORATION_TARBALL:?Missing BLOCKNOTE_COLLABORATION_TARBALL}"
: "${BLOCKNOTE_COLLABORATION_SERVER_TARBALL:?Missing BLOCKNOTE_COLLABORATION_SERVER_TARBALL}"
: "${BLOCKNOTE_TEST_UTILS_TARBALL:?Missing BLOCKNOTE_TEST_UTILS_TARBALL}"

rm -rf "$TARBALLS_DIR" "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/.next"
mkdir -p "$TARBALLS_DIR"

cp "$BLOCKNOTE_CORE_TARBALL" "$TARBALLS_DIR/blocknote-core-0.50.0.tgz"
cp "$BLOCKNOTE_REACT_TARBALL" "$TARBALLS_DIR/blocknote-react-0.50.0.tgz"
cp "$BLOCKNOTE_SERVER_UTIL_TARBALL" "$TARBALLS_DIR/blocknote-server-util-0.50.0.tgz"
cp "$BLOCKNOTE_COLLABORATION_TARBALL" "$TARBALLS_DIR/blocknote-collaboration-0.50.0.tgz"
cp "$BLOCKNOTE_COLLABORATION_SERVER_TARBALL" "$TARBALLS_DIR/blocknote-collaboration-server-0.50.0.tgz"
cp "$BLOCKNOTE_TEST_UTILS_TARBALL" "$TARBALLS_DIR/blocknote-test-utils-0.50.0.tgz"

cd "$SCRIPT_DIR"
if [ -n "${BLOCKNOTE_PNPM_CLI:-}" ]; then
  node "$BLOCKNOTE_PNPM_CLI" --pm-on-fail=ignore install --lockfile=false --ignore-scripts --prefer-offline
else
  pnpm install --lockfile=false --ignore-scripts --prefer-offline
fi
