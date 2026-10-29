# dsh-workspace-session-mgmt

Live workspace session management for DeepSeek Harness (DSH): archive, unarchive and pin a session through the running Workspace registry, and reconcile external edits to `workspace.json` into that running registry.

## Wiring

Bundle patch: `cordis.patch.yml`, single entry point `index.js`.

## Scope

This plugin talks to the **running** Workspace registry. Reconciling means: if `workspace.json` is edited on disk while a profile is up, the registry catches up instead of silently disagreeing with the file.
