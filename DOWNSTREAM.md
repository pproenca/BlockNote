# Downstream extensions

This fork tracks `TypeCellOS/BlockNote`. Its public `main` branch contains the
downstream changes and is the branch consumers should inspect. The `upstream`
remote remains the source for BlockNote updates.

## Design rules

- Fix defects in source and offer generally useful fixes upstream.
- Ship optional behavior as a `createExtension` extension or a separate package.
- Keep every optional extension disabled unless a consumer installs it.
- Keep application authentication, roles, databases, notifications, and tenant
  policy outside BlockNote.
- Accept capabilities, storage adapters, and mutation callbacks through public
  extension options. The application server remains authoritative.
- Keep shared BlockNote runtimes as peer dependencies across adapter packages so
  a consumer cannot install competing editor instances.
- Change core behavior only when a public extension seam cannot express the
  requirement, and keep that change independently reviewable.
- Keep downstream commits small enough to rebase or replay onto a new upstream
  release without carrying generated bundle changes.

Comments, suggestions, and editor policy will be developed as independent
extensions. A consumer can adopt each feature without adopting the others.

## Releases

Tags named `pf-v<upstream>.<revision>` publish immutable GitHub tarballs and npm
packages. For example, `pf-v0.52.1.3` publishes npm version
`0.52.1-pf.3`.

The npm distribution will use the public packages
`@pproenca/blocknote-core`, `@pproenca/blocknote-react`, and
`@pproenca/blocknote-server-util`. Consumers can install them under the normal
BlockNote import names with npm aliases, keeping application imports unchanged.

```json
{
  "@blocknote/core": "npm:@pproenca/blocknote-core@0.52.1-pf.3",
  "@blocknote/react": "npm:@pproenca/blocknote-react@0.52.1-pf.3",
  "@blocknote/server-util": "npm:@pproenca/blocknote-server-util@0.52.1-pf.3"
}
```

The release workflow uses npm trusted publishing. Each package authorizes the
`pproenca/BlockNote` repository and `downstream-release.yml` workflow; no npm
token is stored in GitHub.

## Updating upstream

1. Fetch `upstream/main`.
2. Merge `upstream/main` into this fork's `main` without rewriting published
   history.
3. Run BlockNote's build, lint, unit, and relevant browser tests.
4. Tag a new `pf-v*` release and update consumers to its immutable artifacts.
