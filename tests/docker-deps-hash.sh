#!/usr/bin/env bash

blocknote_e2e_dep_files() {
  {
    echo .dockerignore
    echo pnpm-lock.yaml
    echo pnpm-workspace.yaml
    echo tests/Dockerfile
    echo tests/docker-build.sh
    echo tests/docker-run.sh
    echo tests/docker-deps-hash.sh
    echo ../yjs/package.json
    find patches examples \( -name node_modules -prune \) -o -type f -print 2>/dev/null
    find . -name package.json \
      -not -path '*/node_modules/*' \
      -not -path '*/.git/*' \
      -not -path '*/dist/*'
  } | sort -u
}

blocknote_e2e_content_hash() {
  blocknote_e2e_dep_files |
    while IFS= read -r file; do
      printf '%s\0' "$file"
    done |
    xargs -0 shasum -a 256 -- 2>/dev/null |
    shasum -a 256 |
    cut -d' ' -f1
}
