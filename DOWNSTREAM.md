# Downstream extensions

This fork tracks `TypeCellOS/BlockNote`. Its `main` branch mirrors upstream;
downstream releases are cut from a short-lived integration branch.

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

Tags named `pf-v*` build immutable tarballs for `@blocknote/core`,
`@blocknote/react`, and `@blocknote/server-util`. Consumers pin the release URL
and commit instead of tracking a moving branch.

## Updating upstream

1. Fast-forward `main` from `TypeCellOS/BlockNote`.
2. Rebase the downstream integration branch onto `main`.
3. Run BlockNote's build, lint, unit, and relevant browser tests.
4. Tag a new `pf-v*` release and update consumers to its immutable artifacts.
