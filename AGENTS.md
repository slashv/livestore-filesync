See README.md for a high-level overview of the project.

We use Node 24 so if that is not the current node version use `nvm use 24` before running pnpm commands.

The files to be edited are in the packages folder.

A reference implementation is available in the reference/vue-livestore-filesync folder.
A copy of livestore is available in the reference/livestore folder.

NEVER EDIT FILES IN THE reference FOLDER.

Use the tasks/ folder for persistent implementation plans. Documents in this folder might not be up to date so only use for historical reference context.

Use the docs/ folder for up to date documentation. If we change any aspects relating to documents in this folder make sure to keep the docs updated.

After completed a task always:
- Make sure docs are updated to reflect and relevant changes (README.md and docs/ files)
- Ensure tests pass (pnpm test)
- Ensure types are correct (pnpm check)
- Ensure no linting error (pnpm lint / pnpm lint-fix and manually fix any remaining lint issues)