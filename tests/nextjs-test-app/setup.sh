#!/bin/bash

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARBALLS_DIR="$SCRIPT_DIR/.tarballs"

: "${BLOCKNOTE_CORE_TARBALL:?Missing BLOCKNOTE_CORE_TARBALL}"
: "${BLOCKNOTE_REACT_TARBALL:?Missing BLOCKNOTE_REACT_TARBALL}"
: "${BLOCKNOTE_SERVER_UTIL_TARBALL:?Missing BLOCKNOTE_SERVER_UTIL_TARBALL}"
: "${BLOCKNOTE_MANTINE_TARBALL:?Missing BLOCKNOTE_MANTINE_TARBALL}"

rm -rf "$TARBALLS_DIR" "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/.next"
mkdir -p "$TARBALLS_DIR"

cp "$BLOCKNOTE_CORE_TARBALL" "$TARBALLS_DIR/blocknote-core-0.50.0.tgz"
cp "$BLOCKNOTE_REACT_TARBALL" "$TARBALLS_DIR/blocknote-react-0.50.0.tgz"
cp "$BLOCKNOTE_SERVER_UTIL_TARBALL" "$TARBALLS_DIR/blocknote-server-util-0.50.0.tgz"
cp "$BLOCKNOTE_MANTINE_TARBALL" "$TARBALLS_DIR/blocknote-mantine-0.50.0.tgz"

cd "$SCRIPT_DIR"
pnpm install --lockfile=false --ignore-scripts --prefer-offline
