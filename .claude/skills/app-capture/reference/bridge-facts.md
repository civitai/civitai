# The bridge facts, encoded as guards

Demoted from `SKILL.md` 2026-08-24 (size prune). VERBATIM.

🔴 **THE NUMBERS 1-7 BELOW ARE AN API — DO NOT RENUMBER.** Fact 6 cites "the fact
above" by position, and prose elsewhere refers to these by number; renumbering breaks
every such citation while leaving all PATHS valid, so no gate can see it. Append as 8,
9, … and leave gaps where something is removed.

🔴 **THESE FACTS NOW HAVE A SECOND HOME, AND IT IS NOT A DUPLICATE — CORRECT BOTH.**
`<devrc>/scripts/browser-bridge/reference/sites/civit.ai.md` carries the platform half
of this list, registered so the bridge names it in the `site_notes` field of every
envelope from a `<slug>.civit.ai` host. The two are different framings, deliberately:
**here** they are guard *rationale*, numbered as an API and each one a `plan.py`
refusal; **there** they are orientation for an agent driving a block **by hand**, where
no guard exists to refuse anything. A fact that turns out to be wrong is wrong in both
— fix both in the same change, and do not let one become the stale copy.
(Facts 5 and 6 are app-capture policy, not site truth, and are correctly absent there.)

## 🔴 The bridge facts, encoded as guards

Driven through the browser bridge at `<devrc>/scripts/browser-bridge/browser` (its own
`SKILL.md` sits next to it). Every item below is a *refusal* in `plan.py`, not advice:

1. **App Blocks render in a cross-origin iframe** (`<slug>.civit.ai` inside
   `civitai.com/apps/run/<slug>`). Top-frame selectors find nothing and injected JS returns
   `null` — which reads as a broken bridge. Every DOM op carries `--frame <id>`, a
   post-condition (`dom_op_unscoped`) since 2026-08-23 and a call-site habit before it:
   `emit_dom` adds the flag but `emit_tab` takes any op name, and `DOM_OPS` was declared and
   never read. 🔴 **It is a SAFETY guard, not just a correctness one** — a `--frame` op is
   dispatched synthetically (`trusted:false`), while a **top-frame** `click`/`type`/`key` takes
   CDP `Input.dispatch*Event` and is `trusted:true`. That is a second route to a trusted event
   spelling no `xdotool`, so `guard_no_actuation` passes it: the two guards do not overlap.
   ⚠️ **The parenthetical "which is why the spend path rejects it" is RETRACTED** (measured
   2026-08-30): there is no `isTrusted`/`userActivation` check on the spend path at all, and
   `blocks.submitWorkflow` is a `publicProcedure` taking the block JWT as an input. The
   `trusted:false`/`trusted:true` distinction above is still **true of the events**; it simply
   is not what stops a spend. Full retraction and its controls: `SKILL.md` → "The spend path".
   The guard's own justification is unaffected — it rests on the event distinction, not on the
   server's behaviour.
2. **The frame id changes every load** (819, 821, 828, 830, 832 in one session). A `nav`
   *ends* the plan with a `reobserve` sentinel; no frame-scoped step can follow it.
3. **Apps boot slowly.** The frame does not exist right after `open` — a missing frame is a
   refusal that says *poll again*, never a silent top-frame fallback.
4. **Tabs are created hidden and throttled.** `wake --wait 4000` follows every view change,
   and a settle wake precedes each capture's foreground re-assert. A throttled capture is a
   blank page. `wake` un-throttles *rendering*. 🔴 **RETRACTED 2026-08-24:** the rest of this
   fact used to read "it does not complete the `BLOCK_INIT` handshake, which is why
   foregrounding is a separate, mandatory step" — foregrounding is **not** mandatory, App
   Blocks boot hidden (4/4). The wake is still needed against throttling.
5. **`screenshot` takes no path argument** — it writes its own temp file and prints `path`.
   Passing a path is auto-**rejected** under `opencode`'s `external_directory` rule.
6. **`browser activate` is PERMITTED, and confined to its four declared positions** — never
   an unmarked one, and never a substitute for `wake`. 🔴 **RETRACTED 2026-08-24:** it is not
   REQUIRED, and the old blanket ban did not make capture "impossible" — that followed from
   the retracted 5/5 in fact 4. What replaced the ban bans ACTUATION instead, and that half
   stands on its own. Note `activate` still makes the tab its window's **active tab** even
   though the i3 window raise is withheld. 🔴 **That raise is withheld because every
   capture-path activate says `--no-focus`** — corrected 2026-08-28 from "withheld without
   `--focus`", which does not follow: the CLI defaults the flag ON when stdout is a TTY.
   `.claude/skills/app-capture/reference/foreground-and-spend.md`.
7. **Logged out, `/apps/run/<slug>` is a plain 404**, byte-identical to a nonexistent slug.
   A 404 crops and frames just as well as a real app, so this check runs first.

## Instrument limits — NOT guards, and nothing refuses them for you

🔴 **Deliberately NOT numbered 8/9/10.** Every numbered fact above is a `plan.py`
refusal; these are things the instrument *cannot do*. Numbering them here would claim a
guard that does not exist. All four were measured 2026-09-03 while trying to photograph
an App Block's **pre-ready** paint, and each one cost a round before it was understood.

- 🔴 **`capture.sh` CANNOT observe a pre-ready window — by construction, not by accident.**
  Every state opens with a mandatory app-READY gate (`no_ready_gate`), so the run waits for
  exactly the window you are trying to photograph to END. If the question is "what does the
  app paint *before* it is ready" — a boot skeleton, a loading state, a theme flash —
  `capture.sh` is the wrong tool and will answer a different question convincingly.

- 🔴 **A top-level load of `<slug>.civit.ai` WILL NOT HOLD STILL.** It serves 200 with no
  HTTP redirect, so it looks like a way to freeze a block with no host — but
  `@civitai/blocks-react` `dist/internal/directLoad.js` bounces to
  `civitai.com/apps/run/<slug>` after `DIRECT_LOAD_TIMEOUT_MS = 2000` when no `BLOCK_INIT`
  arrives. That is deliberate (a shared link should land somewhere useful). **Two bridge
  round-trips exceed 2 s**, so a nav-then-read sequence reads the HOST page and reports the
  block's values as absent. The tell is `location.href` coming back as `/apps/run/<slug>`
  when you navigated to the bare origin.

- 🔴 **`browser emulate --color-scheme` DOES NOT REACH THE BLOCK IFRAME.** The block is a
  cross-origin OOPIF with its own renderer, and the override is applied to the tab's
  top-level target. Measured with a positive control: with a CDP-session read the TOP frame
  correctly reported `osDark: False`, while the durable `data-civitai-boot-theme` the block
  wrote at load still read `dark`. **So an OS-vs-host theme mismatch cannot be staged from
  outside** — if you need one, change the HOST theme (a real change to the operator's
  account — ask first) or accept that the case is unobservable.

- **`--wake` and `--frame` are mutually exclusive** (`wake_with_frame_unsupported`):
  un-throttling is tab-level. Wake the tab, then issue the framed read as a separate op.
  Note the emulation above is only live *inside a CDP session*, so a plain framed read sees
  no override either way — which is why the durable attribute, not `matchMedia`, is the
  thing to read back.

🔴 **The generalisable half:** an app's boot state is transient by definition, and a
screenshot race against it is the reassuring-zero trap — miss the frame and you report "no
flash" from a sample you never took. Prefer a **durable artifact** the boot wrote and left
behind (here `<html data-civitai-boot-theme>`, set once at parse and never removed) over
trying to catch the paint. If no durable artifact exists, say the transient was not
observed rather than implying it was.
