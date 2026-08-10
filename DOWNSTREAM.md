# Downstream extensions

This mirror tracks `TypeCellOS/BlockNote`. Product Factory is its development
authority. The public `master` branch is the exact outward mirror consumers
should inspect; the `upstream` remote remains the source for BlockNote updates.

Standalone work requires the native Yjs mirror checked out as the non-empty
`../yjs` sibling. `.github/native-y.json` pins its exact `master` commit,
package name, and version. Product Factory updates that pin only from a
deterministic `platform/yjs` subtree candidate.

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

The `pf-v<upstream>.<revision>` workflow remains release-ready, but publication
is outside the current Product source-artifact gate. Do not create a tag until
that separate release is authorized.

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

1. Update Product Factory's embedded BlockNote source from upstream.
2. Preserve Product Factory history and generate the `master` mirror with a
   deterministic subtree split.
3. Run BlockNote's build, lint, unit, and relevant browser tests.
4. Refresh the pinned Yjs split when its embedded tree changes.
