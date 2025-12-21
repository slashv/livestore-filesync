# Stage 2

## Simplify framework adapters

The current Vue and React adapters re-implement way too much custom code. These should be super light. The only component they should really need to implement is the FileSyncProvider and even that should be extremely light weight. If you look at vue-livestore-filesync/src/components/file-sync-provider.vue you can see how simple it is for Vue.

We do not want any custom composables / hooks. The only methods that we should need and that should be imported from the core library are saveFile, deleteFile, updateFile and readFile. For now we don't want any additional logic around these, instead in the examples we can use a similar strategy to how we do it in vue-livestore-filesync/src/components/images.vue

The framework adapters should not need to use Effect. The example applications should definately not use Effect.

## Simplify the example apps

Keep these as simple as realistically possible. Using the patterns we developed in the vue-livestore-filesync reference implementation is a good start. If we can simplify even further that would be good.

## Include Cloudflare remote storage endpoints import

In the reference implementation we have vue-livestore-filesync/src/workers/cloudflare-sync.ts which combines the regular LiveStore sync backend worker with a set of storage endpoints. For apps that use this package we should provide an import so that they can easily add these endpoints to their existing cloudflare worker.

--------

# Implemantation plan

FILL IN IMPLEMENATION STEPS HERE