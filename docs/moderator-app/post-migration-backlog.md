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

- [ ] **Every link to Civitai should use the `.red` domain, not `.com`.** *"Every single link on
      moderator.civitai.com to civitai should go to the .red domain instead of .com."* One env var
      (`CIVITAI_APP_URL`) decides this for `$lib/entity-url` and `$lib/media/edge-url`, so it is close
      to a config change — but `.env.example` currently documents `.com`, and a code comment in
      `bulk-image.service.ts` used to call `.red` "the wrong site" (corrected 2026-08-09). **Do not
      "fix" a `.red` link back to `.com`.**
- [ ] **Model Notes on civitai.com**: they were exported from Retool; show them on `/models/`, and let
      mods add notes and edit their own. The table is `ModelNotes` in the Retool database.
- [ ] **Per-mod app permissions**: *"Allow admin to give access to apps to individual mods instead of
      only relying on roles."* `AppPageAccess` grants per page **per role** today — individual grants
      are the delta.
- [ ] **Light mode toggle.** The app is dark-only by design, so this is a real piece of work.
- [ ] **Three more apps Seb wants to add** (not migrations — new): reaction-cheater, collection-cheater,
      Knights of New.

### Low priority, "to discuss" (same ticket)

- [ ] ToS'd images should not be deletable by the user — removal is sometimes discussed afterwards.
- [ ] Show `userId` instead of `[deleted]` for deleted accounts, for mods.
- [ ] Article comment reports are hard to action — threading takes you somewhere unhelpful.
- [ ] Merge reports on one entity filed under different reasons (AdminAttention vs ToSViolation).
- [ ] Real-person reports should require a comment.
- [ ] Multiple reports on the same `entityId` should keep every reporter's comment, not just the first.
      (Related: report `details` is dropped everywhere in the app today — see the parity list.)

## Permissions

- [ ] **Sub-permissions per app.** *"We need sub-permissions per app too or something. Some mods need to
      be able to edit email/username."* Retool has a single "Enable Edits" toggle; the ask is for real
      per-capability grants. Our `AppPageAccess` is per page, so this is a model change, not a UI one.
- [ ] 🎥 **Widen access to the mass ban tool** once it exists — *"That's good for other mods to have
      access to this too."* (Building it at all is parity; who can reach it is this.)

## Blocked on a main-app change, or on a decision (from the User Lookup review, 2026-08-10)

These are the only items the slice review could not close in the spoke. The rest of that review's
findings are done — see the parity checklist.

- [ ] 🔴 **Timed mutes never expire.** `addTimedMute` writes the moderator-DB row and sets
      `muted`/`mutedAt`, but not `User.muteExpiresAt` — and that column is the only thing the main
      app's `processTimedUnmutes` selects on. A 24-hour mute is therefore permanent while the panel
      renders it as expiring. **Cannot be fixed here**: the main app uses `muteExpiresAt !== null` to
      mean "this mute came from strikes", so a spoke-set value would let a strike expiry silently clear
      a moderator's timed mute. Needs an `expiresAt`/`muteHours` parameter on `retool/user → mute`,
      handled in `setUserMuted` with a distinguishable provenance marker.
- [ ] **Strikes write a second, disconnected ledger.** `addUserStrike` inserts into the moderator DB's
      legacy `UserStrikes`; the main app owns `UserStrike` via `retool/strike → create`. Missing
      locally: escalation (≥2 points auto-mutes 3 days, ≥3 indefinite + session invalidation),
      `points`/`expiresAt`, the `StrikeReason` enum, `reportId` attachment, the typed `strike-issued`
      notification and its email, the auto-strike rate limit, and any way to void. The panel is also
      blind to every strike the automated pipeline issued. **Retool never called that endpoint either,
      so this is a deliberate widening, not parity** — it needs a decision before it is work.
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

- [ ] **Editable socials & bio** — 🎥 *"Force logout, you know, edit their socials."* Read-only today.
- [ ] **Editable email / username / display name**, behind the sub-permission above.
- [ ] **Display name from the user table** (distinct from username).
- [ ] **Longer mod notes don't wrap** — a rendering fix carried over from Retool's own complaint.
- [ ] **LoRA training metadata**, plus a clickthrough to the orchestrator dashboard
      (`orchestration-dashboard.civitai.com/job-search?workflow=…`).
- [ ] **Blocked prompts** alongside the prompt list. 🎥 *"You can check their blocked prompts."*
- [ ] **Grant cosmetic items** from the shop panel. 🎥 *"Check their cosmetic shop, potentially grant
      them items."*
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
