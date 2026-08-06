// TEMPORARY — DO NOT MERGE. Delete this file along with its PR.
//
// This file exists to make `pnpm run typecheck` fail on purpose, exactly once,
// so we can confirm that a newly-added CI check actually reports a FAILURE and
// not just a success. A check that has only ever been observed green has not
// been shown to work: it is indistinguishable from one that reports green
// unconditionally. The only way to tell the two apart is to make it go red on
// demand and watch.
//
// The error below is a plain assignability violation, chosen because it needs no
// imports, touches no runtime code path, and cannot be "fixed" incidentally by a
// lint autofix or a formatter.

export const ciTypecheckProbe: number = 'this is deliberately not a number';
