# Rollback: pre-editor build

Production was moved to the commit immediately before the OpenCut/mobile editor install sequence.

Restored application commit:

`7b70667aab9858f8e413b138095911688a946e22`

The next commit after that was the first editor install commit:

`93f65d4a6421116e2cae37a61e69106ad9473e25` — Add OpenCut mobile editor types

Previous state was preserved on:

`backup-before-pre-editor-rollback-2026-07-05`

This marker commit exists only to trigger a normal Vercel deployment from the restored code state.
