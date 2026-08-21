# Post-migration backlog — asked for, but Retool never had it

**Do not work on any of this until [`retool-parity-checklist.md`](retool-parity-checklist.md) is done.**
The priority is a 1:1 migration; everything here is an improvement the moderation team asked for on top
of what Retool does today.

The split rule: if Retool does it now, it is parity. If it is phrased as *"it would be nice"*,
*"preferably"*, *"we would need"* — or it simply does not exist in the export — it is here.

Sources: the ClickUp subtask descriptions under `868kkxqpn` and two Loom walkthroughs (transcripts,
2026-08-09). 🎥 marks a walkthrough quote.

The moderators' 2026-08-12/13 feedback round is recorded in the parity checklist
([§12](retool-parity-checklist.md#12-moderation-team-feedback-round--2026-08-12--08-13)), not here —
almost all of it is a defect or a gap against Retool. Anything from that round that turns out to be an
improvement gets moved down here rather than copied.

---

## From "Misc Mod Asks" (`868kn8aa0`) — a subtask the tracker never listed

- [x] **Every link to Civitai should use the `.red` domain, not `.com`.** *"Every single link on
      moderator.civitai.com to civitai should go to the .red domain instead of .com."* **Done** — and it
      needed a second variable rather than a config change. `CIVITAI_LINK_URL` defaults to
      `https://civitai.red` and backs `data.civitaiUrl`; `CIVITAI_APP_URL` stays `.com` because it is the
      API base and the session cookie those calls relay is issued for `.civitai.com`. It deliberately
      does NOT fall back to `CIVITAI_APP_URL` — when it did, every moderator link went to `.com`.
      **Do not "fix" a `.red` link back to `.com`.**
- [ ] **Model Notes on civitai.com**: they were exported from Retool; show them on `/models/`, and let
      mods add notes and edit their own. The table is `ModelNotes` in the Retool database.
- [ ] **Per-mod app permissions**: *"Allow admin to give access to apps to individual mods instead of
      only relying on roles."* `AppPageAccess` grants per page **per role** today — individual grants
      are the delta.
- [ ] **Light mode toggle.** The app is dark-only by design, so this is a real piece of work.
- [ ] **Three more apps Seb wants to add** (not migrations — new): reaction-cheater, collection-cheater,
      Knights of New.

### Dashboard and Urgent Reports (same ticket, never tracked until 2026-08-21)

Re-read off the live ticket 2026-08-21; the section above had captured the middle of it and not these.

- [x] **A reported account or post opens the queue that rules on it.** *"In the urgent reports, user
      should link to the User Report page and highlight/pick that User Report"*, and *"when we have the
      post reports page, same as above"* — which became possible the day Post Reports shipped. The Most
      reported table now sends `reportedUser` rows to `/retool/user-reports?user=` and `post` rows to
      `/retool/post-reports?post=`, falling back to the site link for anyone whose `data.nav` says they
      cannot open that queue. Every other entity keeps the site link — that is where it gets judged.
- [ ] **Image reports are listed twice on the dashboard** — once under Reports and once under Images.
      *"No reason to show image reports here, they're listed under images."* Both are real queues
      (`/reports/image` is the report; `/images/reported` is the triage grid), so this is a decision
      about which one the dashboard should carry, not a removal anyone should make unilaterally.
- [ ] **Move the user-reports count next to the User Reports app.** *"We have a user reports app, move
      the number to be next to that instead."* Same shape as above and the same open question: the count
      currently hangs off `/reports/reportedUser`, and `/retool/user-reports` has no `countKey`.
- [ ] **"Fix" / "unknown" on the urgent rows is not self-explanatory** — *"what does it mean?"*.
      `unknown` is `entityLabel`'s output when a report has no row in ANY of the fifteen report tables
      (`entity: 'other'`). Needs a label that says that, and someone to say what "Fix" was.

### Not in any checklist before 2026-08-21, and not buildable here

- [ ] **CommentV2 has no ToS field**, so moderators cannot ToS article comments etc. on the site. Main-app
      schema change.
- [x] **Unpublishing toggle — the MINOR half.** `UnpublishModal` offers "Also mark this model as
      depicting a minor" on the two minor reasons (`mature-underage`, `photo-real-underage`), ticked by
      default, and runs `model.setMinor` **before** the unpublish: that mutation snapshots the model's
      pre-flag state and propagates the flag to its images, so running it afterwards would snapshot a
      model that is already down. A failure stops the unpublish rather than leaving a model down and
      unflagged. Model-level only — `setMinor` flags the whole model, so offering it on a *version*
      unpublish would act wider than the button says.

- [ ] 🔴 **Unpublishing toggle — the POI half needs a decision, and this is the first time anyone has
      looked.** It was filed as one item with the minor half; it is not.

      `minor` has a whole subsystem: `setModelMinor` (snapshot, `MINOR_LOCKED_PROPERTIES`, forces
      `sfwOnly`, rewrites gallery level, propagates to images), a `moderatorProcedure`, and four
      `minor-flag/*` mod endpoints. **`poi` has none of it.** `Model.poi` is a plain optional field on
      the model upsert schema, with no setter, no cascade, no endpoint and no snapshot.

      So "mark it poi in the same gesture" cannot be built without first deciding what marking a model
      poi is supposed to DO — cascade to its images? lock properties? force a rating? notify? Writing
      `poi: true` from a modal would invent those answers silently, which is the failure mode that flag
      exists to prevent. Needs the same treatment `minor` got, or an explicit "it is just a column".
- [ ] **When are users notified that their model was marked as a minor?** — automated marks vs manual.
      A question to answer, not work to do.
- [ ] **Data collection: the REASON for a rating change.** Distinct from the before/after pair
      `RatingChanges` now records (2026-08-21) — this asks for why, which needs a reason on the rating
      control itself.
- [ ] **Creator Shop: cosmetics created by a user**, with status, created date, history, icon and current
      cost — plus who purchased each. *(From the ticket's comment thread, 08-13.)* Currently unanswerable
      without going to a person.

### Low priority, "to discuss" (same ticket)

- [ ] ToS'd images should not be deletable by the user — removal is sometimes discussed afterwards.
- [ ] Show `userId` instead of `[deleted]` for deleted accounts, for mods.
- [ ] Article comment reports are hard to action — threading takes you somewhere unhelpful.
- [ ] Merge reports on one entity filed under different reasons (AdminAttention vs ToSViolation).
- [ ] Real-person reports should require a comment.
- [ ] Multiple reports on the same `entityId` should keep every reporter's comment, not just the first.
      (Related: report `details` is dropped everywhere in the app today — see the parity list.)

## Permissions

- [x] **Sub-permissions per app.** *"We need sub-permissions per app too or something. Some mods need to
      be able to edit email/username."* Retool has a single "Enable Edits" toggle; the ask was for real
      per-capability grants. Built 2026-08-14 — [`page-feature-permissions.md`](page-feature-permissions.md).
      It turned out **not** to need a model change: `AppPageAccess` is `(app, path) → roles[]`, so an
      action grant is a row keyed `grant:<id>`.
      **Reshaped 2026-08-19:** the first version keyed rows by page and seeded `defaultRoles`, which is
      what silently zeroed five of them; permissions no longer name a page and there are no defaults, so a
      new one is held by nobody until ticked on `/admin`.
- [ ] 🎥 **Widen access to the mass ban tool** once it exists — *"That's good for other mods to have
      access to this too."* (Building it at all is parity; who can reach it is this.)

## Blocked on a main-app change, or on a decision (from the User Lookup review, 2026-08-10)

These are the only items the slice review could not close in the spoke. The rest of that review's
findings are done — see the parity checklist.

- [x] ~~🔴 **Timed mutes never expire / provenance is not enforced.**~~ **Both halves closed 2026-08-20.**

      Expiry: the spoke writes `User.muteExpiresAt`, drained hourly by `processTimedUnmutesJob`.

      Provenance: **`mutedAt` is the marker, and `meta.manualMute` is gone.** The flag was written by
      two apps and read by none, while `mutedAt` already carried exactly this meaning for
      `confirm-mutes`, `entity-moderation`, `prepare-leaderboard` and the generation notice — every
      automatic mute path leaves it null, every moderator path sets it. `evaluateStrikeEscalation` now
      refuses to lift OR shorten a mute carrying it, and the two strike unmute paths clear it, so it
      cannot go stale and mislabel the next automatic mute. Two tests cover the guard and both fail on
      a revert.
- [x] ~~**Strikes write a second, disconnected ledger.**~~ **Closed** — `issueStrike` writes the main
      app's `UserStrike` through `retool/strike → create`, so escalation, points, expiry, the
      `StrikeReason` enum, `reportId`, the typed notification and its email, and the void path all come
      with it. Legacy `UserStrikes` rows are still read alongside so history is not lost. Same item as
      the ticked one in `retool-parity-checklist.md`.
- [ ] **Nobody has looked at the page.** `apps/moderator/CLAUDE.md` is explicit that a segment which
      only typechecks is not done. Every component here has been compiled through Vite, but no
      moderator-app page in this slice has been rendered in a browser — and the two worst bugs found
      this week (a blank optional field rejecting every Buzz transaction, and entity linkage silently
      dropped from the ledger) were both things one real submission would have caught immediately.
      Needs a signed-in session against the auth hub.
- [x] 🔒 **Support-tool API key** — confirmed 2026-08-10 it was **never committed**: it was redacted
      before the raw export's only commit, which was never pushed. Nothing to remediate here. It lives
      in a ClickUp ticket body; whether that warrants rotation is an owner's call, and the specifics
      belong in the private infra repo rather than a public one.

## User Lookup

- [x] **Editable socials & bio** — 🎥 *"Force logout, you know, edit their socials."* `addSocial`,
      `removeSocial` and `clearProfileText`, wired behind grants on `SocialsPanel`.
- [x] **Editable email / username / display name**, behind the sub-permission above — now
      `identity.edit`, seeded to senior. The form itself already existed; what it lacked was the gate.
- [ ] **Display name from the user table** (distinct from username).
- [ ] **Longer mod notes don't wrap** — a rendering fix carried over from Retool's own complaint.
- [ ] **LoRA training metadata**, plus a clickthrough to the orchestrator dashboard
      (`orchestration-dashboard.civitai.com/job-search?workflow=…`).
- [ ] **Blocked prompts** alongside the prompt list. 🎥 *"You can check their blocked prompts."*
- [x] **Grant cosmetic items** from the shop panel — `grantCosmetic`, behind `user.cosmetics.grant`.
      🎥 *"Check their cosmetic shop, potentially grant them items."*
- [ ] **Multi-select comments to ToS/delete them.** The ask is a selection UI; the bulk endpoints exist.
- [ ] **More than 50 buzz entries.** *"Only showing 50 buzz entries will be too few for support to
      troubleshoot issues."* (The Payments/Receipts split and filters are parity; raising the cap is not.)
- [ ] 🎥 **Ban-evasion view**: other accounts sharing an ISP, and whether action has been taken on each.
      *"Very important to track down people who try to avoid bans, repeat abusers."* We show shared
      IPs/socials; the same-ISP dimension and the per-account action state are extra.

## Bulk Image Manager

- [x] 🎥 **Model ID and model version ID as sources.** *"Enter any username, user ID or post ID —
      preferably also model ID and model version ID."* **Already built** — the port went beyond Retool
      here. Noted so nobody removes it as unfaithful.
- [ ] 🎥 **Date filter** — *"Another filter that would be good is dates, like when the image was
      created."* Explicitly a wish, not current behaviour.

## Models

- [ ] 🎥 **Model notes in the main app.** *"Mods can leave notes on models, and it would be nice to have
      that in the main app."* Retool has model notes; surfacing them in civitai.com is the ask.
- [ ] Mod-made changes to a user's models, visible in their activity. *"If possible, it would be nice."*

## Dashboard

- [ ] 🎥 **Per-queue thresholds with colour.** *"Green indicates this is fine — four images in POI — but
      400 reported images is more of an emergency… different queues would have different thresholds."*
      We show counts; the thresholds and the traffic-light are the ask.

## Article Lookup

- [ ] 🎥 **Generalise it to any entity.** *"Could have just been general for most entities — bounties,
      all that stuff."*

## Explicitly NOT wanted

Recorded so nobody ports them by reflex:

- 🎥 **Model reports** — *"No, we don't need this one, actually."*
- 🎥 **Moderation rules UI** — *"Moderation rules live here. We don't really use them though."* Retool
      has the UI; the team does not use it. Confirm before porting.
- 🎥 **Front Page Audit may be obsolete** — *"I'm not sure if we need to do this anymore… only a few
      videos per day get flagged."* Ask before investing further. (Listed in parity too, because it is
      built and half-finished — the decision governs both.)
