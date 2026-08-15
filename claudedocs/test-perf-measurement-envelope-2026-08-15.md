# The measuring box moves further than most of the effects we measured

Recorded 2026-08-15 from the unit-suite performance work. This is the number that decides which of
the day's other numbers are readable, so it belongs beside them rather than inside any one PR.

## The measurement

Two **identical** full unit-suite runs, back to back, same tree, same config, nothing changed
between them:

```
drift-2   wall 216.6s   collect 4852s
drift-3   wall 253.8s   collect 5845s     +20.5% collect, +17.2% wall
```

⚠️ **That pair was contaminated** — another agent's suite started during the second run; five vitest
workers were live on the box immediately afterwards. So `+20.5%` is not a drift *figure*. It is a
demonstration that this box can move that far while nothing under measurement changes, which is the
part that matters: **any comparison assembled from two different windows sits inside that envelope.**

A clean drift pair still has not been taken. Anyone who gets eight consecutive quiet minutes should
take one; it is the denominator for everything else.

## What follows from it

**1. Quote in-pair controls, not cross-window deltas.** A wall-clock difference between a run taken
now and a run taken an hour ago is unreadable. The readable form is a single pair with a control
group inside it — files the change cannot have affected — reported *first*, before the headline.
`scripts/test-perf/compare-runs.mjs` does this and prints the control group with the header "if this
moved, the headline below is drift, not the change."

**2. A control group must be comparable in COST, not just in count.** A control of 353 files
carrying 113s of `collect` cannot carry a null for a 4,730s run. Split by per-file cost and the
weakness is visible immediately:

```
control group, cheaper half   177 files   6s -> 11s   +18.9%
```

Two seconds of absolute noise rendered as a large percentage. A good control was 306 files carrying
1,903s and flat to 0.4%.

**3. Dose-response is suggestive, not conclusive, when the axis is confounded.** Pre-bundling five
external packages showed a clean-looking gradient — files reaching none of them moved −6.9%, files
reaching one or two moved −31%/−30%. That argues the effect is real rather than ambient, *except*
that mean per-file `collect` rises monotonically with exposure (0.32s → 10.43s), so "sorts by
exposure" and "sorts by file weight" are not separated by that data. The contaminated drift pair
sorted by exposure too, inversely. **Load can produce a gradient on any axis that correlates with
file cost.**

**4. A crashed run's wall clock is not a fast run.** The `threads` pool was believed 1.5x faster than
`forks` for most of a day. Those runs segfaulted in the shutdown path and wrote no report: the clock
measured time-to-a-teardown-that-never-finished. Completed runs put `threads` at **1.04x at 4 workers
and 0.94x at 16** — no win at either width. A number from a run that did not finish cannot support a
claim about work that did.

**5. "Is the box quiet" is a question about the next N minutes; every check we have measures one
instant.** Three failures in one day, three different shapes:

- a window granted while another agent's suite was still running;
- a gate written as `node processes <= 4`, which **cannot fire** — seven idle agent sessions plus
  their MCP servers plus the dev-server daemon are ~30 node processes at rest;
- a genuine zero sample that was simply the gap between two of someone's short runs.

The check that works is *for the workload, not the runtime*:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  ForEach-Object { $_.CommandLine } |
  Where-Object { $_ -match 'vitest|tinypool' } |
  Measure-Object | Select-Object -ExpandProperty Count
```

Sample it **twice, 30 seconds apart**, so a gap between two files does not read as done. And treat a
window as a commitment from whoever holds the box, not as an inference from a process count.

## The general form

Every one of these is the same mistake wearing different clothes: **a measurement passing because the
thing being measured never happened.** A run that stopped early. A config that emitted no chunk. A
module that never loaded. A gate that could not fire. Verifying that the change was *engaged* — the
chunk on disk, the module body executing, the worker actually spawned — costs seconds and is the only
thing that separates a result from a coincidence.
