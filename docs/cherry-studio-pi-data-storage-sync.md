# Cherry Studio Pi Data Storage And Sync

## Goals

- Keep Redux as a UI state cache only.
- Store durable user data, preferences, workbench shortcuts, and migrated business entities in SQLite.
- Keep cache local and expirable.
- Sync durable records through WebDAV with per-record merge and conflict tracking.

## Local Storage Layout

Main database: `${userData}/Data/app.db`

Tables:

- `app_records`: durable key/value records grouped by `scope`.
- `app_cache`: local-only cache with optional expiration.
- `sync_state`: device id, last synced record hashes, and sync summaries.
- `sync_conflicts`: unresolved conflicts from multi-device edits.
- `workbench_shortcuts`: shortcuts installed into the launchpad/workbench.

Recommended scopes:

- `settings.*`: user preferences.
- `assistant.*`: assistant and agent-facing configuration.
- `workspace.*`: files, workbench shortcuts, generated artifacts.
- `integration.*`: OpenClaw, Hermes, WebDAV, MCP, and other integration settings.

## Sync Protocol

Remote root: `${webdavPath}/sync/v1`

Files:

- `manifest.json`: compact index of all synced records.
- `records/<scope>/<key>.json`: one durable record per file.

Merge rules:

- If only local changed since the last synced hash, upload local.
- If only remote changed since the last synced hash, apply remote.
- If both changed and hashes differ, record a conflict and choose the newest record by `updatedAt` so the client keeps moving.
- Deletes are tombstones, not immediate remote removals, so offline devices can converge.

The current implementation exposes IPC through `window.api.appData` and `window.api.dataSync`; module-level migrations can progressively move old Redux/Dexie data into the durable scopes.
