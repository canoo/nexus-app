# Vendored observability store (pinned copy, CLI-owned)

This directory is a **verbatim pinned copy** of the NEXUS CLI's observability
store, vendored so the app no longer imports it from the CLI repository by a
repo-relative path. The store file format — the SQLite schema owned by these
migrations — is the shared contract between the app and the CLI (sharing
contract A in the app-split plan: versioned control protocol + installed binary
+ versioned store file format).

## Source

- Repository: `canoo/agent-nexus`
- Branch: `feat/v0.3.0-integration` (the #115 branch the app was extracted from)
- Commit: `95ee78f`
- Files copied verbatim (only Node.js builtins are imported, so nothing else
  needed to move with them):
  - `tools/mcp/lib/observability-store.mjs` -> `lib/observability-store.mjs`
  - `tools/mcp/migrations/001_observability.sql` .. `005_companion-collection-boundary.sql`
    -> `migrations/`
- Layout is preserved on purpose: the store resolves its migrations directory
  relative to its own file (`lib/../migrations`), exactly as in the CLI tree.

## Pinned contract

- Minimum `nexus` CLI version: **v0.3.0** (the release that ships these
  migrations; the CLI owns the schema and publishes the migration SQL).
- Control protocol: **v1** (`nexus control --json`).
- Store schema version: **5** (migrations 001-005 applied, in order).

## What uses it

- `apps/companion-native-host/lib/host.mjs` — activity ingestion and retention
  maintenance. The host reads/writes the shared SQLite database
  (`~/.config/nexus/logs/observability.sqlite`) through this copy.
- `apps/companion-desktop/src-tauri` tests — the desktop's Rust tests apply the
  bundled migration SQL and drive the store through Node for boundary checks.
- The native-host payload (`apps/companion-native-host/lib/package.mjs`)
  stages this copy, so a packaged host runs without a CLI checkout.

## Why a vendored copy, not a shell-out

The record path cannot shell out to `nexus companion` / `nexus control --json`
today: protocol v1 has **no record operation**. The CLI's companion surface is
status/pause/resume/disable/consent plus data initialize/status/prune/retention/
clear — ingestion (`recordToolActivity`) exists only in this store module. Until
the CLI gains a `record` operation (a CLI-side protocol change, not an app-repo
change), the host must write the store file directly, and this pinned copy is
how it does that without depending on the CLI source tree.

## Updating

When the CLI ships a new store schema version:

1. Copy the new `observability-store.mjs` and the new/changed migration files
   from the CLI release commit; never hand-edit the vendored files.
2. Update the pin (source commit, minimum CLI version, schema version) above.
3. Re-run the native-host and desktop suites; the migration/boundary
   regression tests cover old-store upgrades.
4. Do not add migrations of the app's own here — the schema is CLI-owned.
   If the app ever needs app-only tables, that is a protocol/schema decision
   with the CLI repo, not a local edit.

## What still assumes a full CLI repository

- `nexus control --json` `companion.command` (used by the desktop data
  controls and the native host's `companion.*` operations) shells out to
  `$NEXUS_REPO/tools/mcp/companion-data.mjs` / `companion-controls.mjs`
  inside the CLI. It works with a curl install (repo clone at
  `~/.config/nexus/repo`) but not with a bare installed binary and no clone.
  That is a CLI-side limitation: the protocol doc's full-repo assumption.
  The app resolves the binary first (`NEXUS_CONTROL_BINARY` / PATH /
  `~/.local/bin/nexus`) and falls back to a repo checkout
  (`NEXUS_CONTROL_ROOT`) where one exists.
- The desktop's data controls fall back to running the CLI's
  `companion-data.mjs` helper under `NEXUS_CONTROL_ROOT` when no usable
  `nexus` binary is found.
