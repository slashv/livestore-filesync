# LiveStore FileSync

## Objective

Create an npm package that allows easily handling file syncing for any LiveStore application.

## Reference implemenation

We have a working example implementation in the vue-livestore-filesync folder. It's only included here for reference during development.

## Implementation details

We are going to use Effect.ts and leverage it's requirements management primitives. The reference services are available in the vue-livestore-filesync/src/services folder.

Each service in the reference implementation should be it's own folder in a src/services folder in this package. Each service should have it's own tests.

Each service should have it's own tests inside it's own folder. To compose the package together we will build layers using Effect.

Applications that use the package should not need to use Effect but if it makes sense to expose certain parts of the public api with Effect primiteces that would be useful.

Because applications that use this package will need to add LiveStore tables and events (see vue-livestore-filesync/src/livestore/schema.ts) we probably want to export those parts and probide documentation on how to import and extend the schema of an app that uses it. In the example implementation we have the images tables but for this package we want to remain file-type agnostic so the images example would just be a reference example in docs or example code referencing a fileId.

We are going to maintain the FileSyncProvider pattern that we use in the reference implementation.

Ideally we would like to use Effect platform filesystem https://effect.website/docs/platform/file-system/ abstraction but it doesn't support OPFS. We can consider creating an OPFS abstraction layer that supports a subset of the Effect platform filesystem API that we need to use but that might be a future enhancement. In the future we would like allow this to work on other platforms too but the primary focus is browser where OPFS is our primary focus. It might be a good idea to aproximate the interface parts we need from https://github.com/Effect-TS/effect/blob/main/packages/platform/src/FileSystem.ts

The first step should be to get something working that we can use say and test.