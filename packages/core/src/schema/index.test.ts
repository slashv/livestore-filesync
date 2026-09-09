import { Schema } from "@livestore/livestore"
import { describe, expect, it } from "vitest"
import { createTestStore } from "../../test/helpers/livestore.js"
import { createFileSyncSchema } from "./index.js"

describe("FileSync cursor event transport", () => {
  const fileSyncSchema = createFileSyncSchema()
  const cursorEventSchema = fileSyncSchema.events.fileSyncCursorSet.schema

  it.each([
    ["epoch milliseconds", 0],
    ["worker JSON ISO string", "1970-01-01T00:00:00.000Z"]
  ])("decodes %s", (_label, updatedAt) => {
    const decoded = Schema.decodeUnknownSync(cursorEventSchema)({
      id: "global",
      value: { lastEventSequence: "e0", updatedAt }
    })

    expect(decoded.value.updatedAt).toEqual(new Date(0))
  })

  it("survives decoded event args crossing a JSON worker boundary", () => {
    const event = fileSyncSchema.events.fileSyncCursorSet({
      lastEventSequence: "e224",
      updatedAt: new Date(0)
    })
    const transportedArgs: unknown = JSON.parse(JSON.stringify(event.args))
    const decoded = Schema.decodeUnknownSync(cursorEventSchema)(transportedArgs)

    expect(decoded).toEqual({
      id: "global",
      value: { lastEventSequence: "e224", updatedAt: new Date(0) }
    })
  })
})

describe("FileCreated replay", () => {
  it("ignores repeated creates for one ID without overriding later updates or deletes", async () => {
    const { deps, events, shutdown, store, tables } = await createTestStore()
    const id = crypto.randomUUID()
    const createdAt = new Date("2026-01-01T00:00:00.000Z")
    const updatedAt = new Date("2026-01-02T00:00:00.000Z")
    const deletedAt = new Date("2026-01-03T00:00:00.000Z")

    try {
      store.commit(
        events.fileCreated({
          id,
          path: "original.txt",
          contentHash: "original-hash",
          metadataJson: "{\"source\":\"original\"}",
          createdAt,
          updatedAt: createdAt
        }),
        events.fileCreated({
          id,
          path: "duplicate.txt",
          contentHash: "duplicate-hash",
          metadataJson: "{\"source\":\"duplicate\"}",
          createdAt: updatedAt,
          updatedAt
        })
      )

      expect(store.query(deps.schema.queryDb(tables.files.where({ id })))).toEqual([
        expect.objectContaining({
          id,
          path: "original.txt",
          contentHash: "original-hash",
          metadataJson: "{\"source\":\"original\"}",
          createdAt,
          updatedAt: createdAt,
          deletedAt: null
        })
      ])

      store.commit(
        events.fileUpdated({
          id,
          path: "updated.txt",
          remoteKey: "remote/updated.txt",
          contentHash: "updated-hash",
          metadataJson: "{\"source\":\"update\"}",
          updatedAt
        }),
        events.fileCreated({
          id,
          path: "late-duplicate.txt",
          contentHash: "late-duplicate-hash",
          createdAt: deletedAt,
          updatedAt: deletedAt
        }),
        events.fileDeleted({ id, deletedAt })
      )

      expect(store.query(deps.schema.queryDb(tables.files.where({ id })))).toEqual([
        expect.objectContaining({
          id,
          path: "updated.txt",
          remoteKey: "remote/updated.txt",
          contentHash: "updated-hash",
          metadataJson: "{\"source\":\"update\"}",
          createdAt,
          updatedAt,
          deletedAt
        })
      ])
    } finally {
      await shutdown()
    }
  })
})
