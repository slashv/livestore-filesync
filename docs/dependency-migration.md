# September 2026 dependency migration

Candidate cohort: LiveStore `0.0.0-snapshot-97407c6622c93eb1ae4c02a40c79743426ee101f`,
Effect and platform packages `4.0.0-rc.111`, Vitest `4.1.10`, and published contrib Node
adapter `0.0.0-snapshot-9fd312cd51d0c38b9e53a78bb4fc211ee4f9c5d2.8aa073fb46b5977e8dbae2be00e8af3b85abbd2f`.
Keep core/Effect overrides aligned with the catalog: contrib's composite version embeds its
older core build commit, while this workspace resolves its runtime against the selected core.

The new upstream fingerprints trigger a state rebuild from persisted events. FileSync event
names, argument encodings, table names, paths, remote keys and retained-blob policy are unchanged.
Replay can log schema-hash mismatch warnings for old events before successfully materializing them.

## Old-store check

The maintained Node example contains `src/migration-smoke.ts`. Build packages in both checkouts,
then run these commands with a fresh shared fixture directory:

```sh
# Old checkout, core snapshot 63cb2f26 / Effect beta.99
pnpm --filter livestore-filesync-node-example exec tsx src/migration-smoke.ts seed /tmp/filesync-upgrade-fixture

# Candidate checkout
pnpm --filter livestore-filesync-node-example exec tsx src/migration-smoke.ts verify /tmp/filesync-upgrade-fixture
pnpm --filter livestore-filesync-node-example exec tsx src/migration-smoke.ts recover /tmp/filesync-upgrade-fixture
```

Copy the harness into the old isolated checkout first. Seeding writes a real SQLite event log,
queued and interrupted local transfer state, an offline edit and cached file bytes. Verify checks
exact metadata and local state plus readable cached bytes. Recover starts FileSync against a local
HTTP upload endpoint and checks that pending/current edited bytes upload. Recovery changes the
fixture state; use a fresh directory for another seed/verify/recover run.

This check exposed a pre-existing Node upload failure: an executor progress callback selected
XMLHttpRequest even on Node. The candidate falls back to fetch when XHR is unavailable.

## Mixed-version Worker check

`examples/node-filesync/src/rollout-smoke.ts` connects real persisted Node clients to a local
sync-cf Worker and exercises event push/pull plus R2 signed upload/download. Run old and new
Workers on separate ports, then run old and new clients against each Worker using the same
store ID but different local directories. The last argument lists file IDs that must be present
and downloadable; use `-` as the write ID to verify after a client restart. The check passed
in both directions with both Worker cohorts. This exercises the wire contract directly;
FileSync's executor recovery is covered separately by the old-store check above.

## Expo 55

The Expo peer ranges include the SDK 55 package versions. A real iOS simulator check reopened
an old PrivateView SQLite store and retained queued/interrupted transfers, offline edits and
cached bytes without clearing the fixture. All three files uploaded after restart.
The image processor now uses Expo's named `ImageManipulator` export for its imperative API.

Native image resize and JPEG upload also pass in the iOS simulator. All 11 PrivateView
Electron scenarios pass. FileSync's full package/Node/React/thumbnail tests, typecheck, lint and
build pass. The six `0.9.0-next.1` package archives have exact portable dependency metadata.
PrivateView's final full browser run passes all 38 tests. An earlier cold-start error was not
reproduced in 12 fresh-store starts or the final full suite. Publication is still pending npm
authentication, followed by a clean PrivateView install of the actual published release.
