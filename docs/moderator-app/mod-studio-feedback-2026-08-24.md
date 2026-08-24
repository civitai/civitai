# Mod Studio feedback — round 2026-08-24

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what this round asked for and whether it is done.

**Scope:** the comment-spam round raised on 2026-08-24, PLUS everything still open from earlier rounds,
carried into the second half of this file.

**This is the live list.** A round gets its own dated file so it is clear when something was first asked
for, and unfinished items move to the newest file rather than being ticked across several — so the
newest file is the only one with open boxes. Earlier rounds:
[`mod-studio-feedback-2026-08-21.md`](mod-studio-feedback-2026-08-21.md),
[`mod-studio-feedback-2026-08-19.md`](mod-studio-feedback-2026-08-19.md),
[`mod-studio-feedback-2026-08-17.md`](mod-studio-feedback-2026-08-17.md).

A separate strike-policy round ran the same day; its decisions and remaining open items are in
[`strike-rules.md`](strike-rules.md) §10, not here.

Reporter identities, message links, quotes and the account ids used as examples are deliberately absent:
this repo is public (CLAUDE.md → Security). The private triage keeps attribution.

> **Update this file in the same commit as the fix**, with a one-line outcome and the sha. An unticked box
> with no note reads as "nobody looked", which is the failure mode this file exists to prevent.

---

## Context this round arrived in

A phishing campaign that ran through profiles and models in February is running again, this time in
**comments**. Every item below is something a moderator hits repeatedly while working one wave, so the
cost is per-account rather than one-off: an extra reload, a second purge step, a search that times out.

Each box records what the code actually does today, verified by reading it — every report here is
accurate, but four of the seven have a cause that is not what the symptom suggests.

## This round

- [x] **User Lookup → Comments has no bulk-select.** Both lists carry a **select-all** now, and it
      follows the **filtered** set rather than the raw one — the search box above each list is what a
      moderator uses to isolate the phishing text, and a select-all that ignored it would take good
      comments with it. It also reaches past the card's own `Show more` fold: the ids are posted from
      the selection rather than from the rendered checkboxes, so "select all 340" acts on 340 and not
      on the five rows on screen.

- [x] **Actioning a comment reloads the whole section.** It no longer reloads anything. The reload was
      the expensive one rather than the cheap one: every panel write called back into
      `[section]/+page.svelte`, which bumped `version` and re-derived `fetchAccount(...)` — one request
      rebuilding the whole *account* payload behind a five-row delete, twice per account because of the
      Model / Other split.

      The list drops the rows it actioned instead, and the Comments section renders nothing else that a
      refresh would feed. A partial success is reported rather than swallowed: both bulk endpoints now
      count rows they actually wrote (they returned `ids.length` before), and the panel prints "N of M
      went through — reload to see which." The action already refuses when nothing at all changed.

      Both lists are one component now (`CommentList.svelte`) rather than two near-identical copies —
      the select-all, the removal and the ToS/delete pair existed twice, and this was the change that
      would have made it three times.

      **Reviews has the same shape and was left alone** — its panel is the other one that bulk-actions a
      list and refreshes the account behind it. Not reported, so not changed; the component it would
      reuse now exists.

- [x] **Ban and Bulk Ban cannot purge comments.** They can now — **"Remove their comments"**, opt-in
      like "remove their images", on both the ban panel and Bulk Ban. There was nothing to add at the
      spoke on its own: the capability did not exist upstream. `setBanned` posts to the main app's
      `/api/mod/ban-user`, which reaches `toggleBan`; that unpublished models and blocked media and
      touched no comment table at all, and the only path that removed comments was
      `/api/mod/remove-all-content` — everything the account ever posted, in one unscoped action.

      `removeComments` now runs the length of that chain: endpoint param → `toggleBan` → the checkbox.
      It **flags, never deletes** — the ToS flag is both what takes the comment off the page and the
      record of why, and an appeal has to be able to read what was taken down.

      It sets `tosViolation` and deliberately **not** `hidden` — see the item below, which is what
      makes the flag sufficient and why the obvious-looking `hidden = true` is the wrong fix.

      Covered by two tests on `toggleBan` (both tables; and that it stays opt-in). Checked against a
      revert: dropping the block fails as `expected "dbWrite.comment.updateMany" to be called`.

- [ ] **Bulk Ban's email-domain search 500s.** It fails for any domain rather than intermittently —
      what varies is whether the scan beats the statement timeout. `getAccountsOnDomains` filters on
      `lower(substring(email from '@(.+)$'))`, an expression no index covered: `User.email` carries
      only its own unique btree on the whole citext value, and a suffix match cannot use it, so every
      call sequentially scanned `User`.

      `20260824120000_user_email_domain_index` adds an expression index that is character-for-character
      what the query emits, partial on the same `bannedAt IS NULL AND deletedAt IS NULL` the query
      always applies — that search is looking for accounts it can still act on, so every banned or
      deleted row would be dead weight. The service now carries a note tying the two together, because
      rewording either side silently returns this to a seq scan with nothing failing to say so.

      🔴 **The index alone did not fix it — `ANALYZE "User";` is part of the migration.** It was
      applied on 2026-08-24 and measured immediately afterwards: live, `indisvalid`, 84 MB, and
      **still refused by the planner**, with the search still taking 23.1 s. Postgres has no statistics
      for an index *expression* until an ANALYZE runs after the index exists, and
      `CREATE INDEX CONCURRENTLY` does not do it — so every domain, one with ~600k accounts and one
      with none, estimated the identical 57,821 rows and the planner kept choosing the primary key.
      The migration file now carries the step and how to confirm the plan changed. **Until that ANALYZE
      runs on the primary this is NOT fixed** — the index is 84 MB of maintenance cost buying nothing.

- [x] **Blocklist "message pattern" does not apply to comments.** It does now, on every comment
      surface — model comments through `upsertCommentHandler`, image / article / post / bounty through
      `upsertComment`, and comic chapter comments through `createChapterComment`, which writes
      `CommentV2` directly. Before this, `throwOnBlockedMessagePattern` had exactly two call
      sites in the repo and both were chat, so a pattern added mid-wave stopped it in DMs and nowhere
      near the surface the wave was using.

      **A comment does not throw the way chat does.** A hard error tells the author which words to
      change, which hands a spam run a free oracle and costs a moderator nothing to lose. The comment is
      accepted and **reported instead**: an automated report, in the same queue Clavata's flags land in,
      carrying which pattern fired and the text it fired on. The author sees an ordinary successful post.

      Three properties worth knowing:

      - **The comment stays visible.** This reports, it does not hide. Hiding on a pattern match is the
        next lever if the queue cannot keep up with a wave — say so and it is a small change — but it
        makes a false positive silently invisible with no route back, so it is not the default.
      - **It cannot fail the post.** The report is best-effort by construction: a comment that has
        already committed must not error afterwards because the report could not be written.
      - **An edit does not re-report.** `Automated` reports skip the duplicate check every other reason
        gets, so one comment edited five times would otherwise be five rows in the queue.

      Moderators are skipped. Five tests on the reporting helper, and one on `upsertComment` asserting
      the wiring — that last one exists because the helper's own tests stay green if the call site is
      removed.

- [ ] **"Comment Spam Identifier" from Retool.** **It exists, it is in the export, and it is already
      ported — the earlier entry here was wrong on all three counts.** It is Retool's **"Comment
      Spammer"** alert in User Lookup's Quick Info, backed by `PotentialSpammerV2`, and it lives in this
      repo as `getCommentBurst` (`user-signals.service.ts`), rendered as an amber line on the
      **Addresses** panel: "N comments in the last 48 hours — possible spam burst."

      **Retool's rule was "more than 2 comments in 48 hours", and its threshold was broken.** The alert's
      visibility expression was `!total_comment_count < 20`, which evaluates `!x` to a boolean first —
      so the 20 never gated anything and the only real gate was the query's own `> 2`. Measured on prod
      2026-08-24: that rule matches **367 accounts right now, 3 of them banned.** So the reason nobody
      could say what it measured is that it measured almost nothing — which is worth knowing before
      rebuilding it faithfully.

      **What the current wave actually looks like** (1,002 accounts banned 2026-08-24, measured from
      ClickHouse `comments` events, which survive the comment deletion that follows a ban):

      | | |
      | --- | --- |
      | account age at ban | p50 **1.1 h**, p90 5.5 h |
      | comments posted | p50 **11**, and 11 is also the p90 — a script that stops |
      | distinct targets | **11** — one comment each, no thread twice |
      | first to last comment | **2 minutes** |

      A candidate rule falls straight out: **≥10 comments on ≥10 distinct targets within one hour.**
      Over 90 days that matches 1,071 accounts, **831 already banned**; of the 240 it matches that are
      not banned, only **4** are recent signups. Adding "account younger than 2 days" is what separates
      the wave from established power users — note the accounts posting *20–39* comments an hour are
      almost all legitimate (1.6% banned), so raw volume alone points the wrong way.

      🔴 **Build it on ClickHouse, not Postgres, and make it a LIST.** `getCommentBurst` reads Postgres,
      and moderators delete the comments when they ban: of the 1,002 accounts in this wave, **2 comments
      remain**. The Postgres signal is therefore blind to any account already actioned, and useless for
      "show me who else did this". The ClickHouse events persist, which also turns the signal from a
      per-account badge into the thing the round actually asked for — a queue of accounts to look at.

      Still needs the mod team: whether those thresholds match their judgement, and whether the badge
      should move off the Addresses panel to Basic where Retool had it.

- [x] **A "newest users" page, for catching fresh spam accounts and ban evaders.** Built at
      **`/users/newest`**, a new `NAVIGATION` entry beside `/users` — which is untouched and still
      renders `Not built yet.` Accounts newest-first straight off
      `User`, so it is current rather than waiting on an index: username and id linking into User
      Lookup, the email with a one-click "filter by @domain" beside it, unverified-email and
      banned / deleted / muted flags, and the bio and profile message — which is where a phishing
      account gives itself away without opening anything.

      A sibling path with its own grant, deliberately. `/users`' page grant is what User Lookup's ban,
      purge and bulk-comment actions are gated on, so a
      read-only list living under it would have made "let them watch new signups" mean "let them ban
      anyone". (That weld is pre-existing and now filed; see below.)

      It **orders by `id`, not `createdAt`** — ids ascend with registration, and the one `createdAt`
      index is partial on `deletedAt IS NULL`, which this query cannot satisfy because it shows deleted
      accounts. The **registration window is mandatory** (24h / 7d / 30d / 90d, default 7d) because it
      is what the scan bound is derived from, and paging is forward-only on an id cursor rather than an
      offset, so registrations arriving mid-read cannot shift a later page.

      🔴 **The window alone did NOT bound the scan, and the first version of this page was unusable.**
      `createdAt >= cutoff` cannot stop a backward walk of the primary key — the walk has no way to
      learn the predicate has gone permanently false. Measured on prod: the page's own "filter by
      @domain" link, on a domain matching nothing, walked to id 1 at **7.1 s and ~96 GB of buffer
      traffic warm, 19.9 s cold**. The fix is a floor: resolve the oldest id inside the window (the one
      query shape that *can* use the partial `createdAt` index), subtract a margin, and add
      `id >= floor`. **118 ms, 60,585 buffers** — 60x latency, 208x I/O. The margin is load-bearing:
      ids and `createdAt` are not strictly monotone (57 inversions across the last 1M accounts, one
      backfilled row 3.5 years out of order), so the floor is loose and `createdAt` still does the exact
      filtering.

      Deliberately not built: per-row content counts. They were unaffordable while `Comment.userId` and
      `CommentV2.userId` carried no index — `20260824140000_comment_user_id_indexes` (below) removes that
      objection, so this is now a sizing question rather than a blocked one.

      **Unverified against a signed-in session** — the route gate answers before the page renders, so
      this was checked by typecheck and by reading. `/users/newest` is a NEW `NAVIGATION` entry with no
      `AppPageAccess` row, so it is admin-only until someone ticks it on `/admin`; filed in
      [`action-grants-review.md`](action-grants-review.md).

---

## Found while in there

Not reported by anyone — these came out of building the two items above, and both are worse than they
look on paper.

- [x] 🔴 **"Remove as ToS" did not remove a comment from image, article, post or bounty threads.**
      Everything except model comments is `CommentV2`, and **not one v2 read filtered on
      `tosViolation`.** So the action a moderator reaches for during a phishing wave set a flag, actioned
      the reports, notified the author — and left the comment on the page. Nothing surfaced it: the
      queue said actioned, and the only way to see it was to open the thread signed out.

      The near-miss worth recording: the fix looks like it should be `hidden = true`, since that is the
      column the v2 thread query filters. It is not. `hidden` is the author's and content owner's own
      hide, and a hidden comment is still served to anyone who opens **"See N hidden comments"** — a
      public modal on every v2 entity type. Hiding a phishing comment would have looked right in the
      queue and left the link reachable in two clicks.

      So the flag became the removal instead: every v2 read now filters `tosViolation` for
      non-moderators — the page, the pinned block, the deep-linked target comment, reply threads, and
      the hidden-count that offers the modal. Moderators still see flagged comments, which is what lets
      the queue check its own work. Three tests, including one on the raw-SQL branch that a typecheck
      cannot see; a revert fails two of them.

- [x] **The ban purge would have seq-scanned both comment tables, on the primary.** `removeComments`
      updates `Comment` and `CommentV2` by `userId`, and **neither table had an index on it**. Measured
      on prod: ~345 ms and 561 MB of buffer traffic for one account on `CommentV2`, the same shape on
      `Comment` — ~0.5 s of primary CPU and ~900 MB per ban.

      Bulk Ban is what makes that dangerous rather than slow. It accepts 1000 accounts, and
      `/api/mod/ban-user` answers **200 before it does the work**, so the loop does not serialise the
      expensive half — a full sweep queues 2000 full-table scans that overlap on one pod.
      `20260824140000_comment_user_id_indexes` adds both indexes (also applied by hand), which turns
      each scan into a sub-millisecond index lookup and fixes every other `userId`-scoped comment query
      on the way past. Bounding the fan-out itself is still worth doing and is not done here.

- [x] **Bulk Ban paced requests, not bans.** `/api/mod/ban-user` answers 200 before it does any of the
      work, so the "sequential, stop after 5 consecutive failures" loop was awaiting an acknowledgement
      rather than a ban: a 1000-account submit handed the primary 1000 overlapping fan-outs — model
      unpublish, media block, comment flagging, search-index removal, subscription cancels — and a
      **silently failing endpoint still reported every account banned**.

      The loop now confirms every 25th ban before continuing, and stops with a 502 naming how many were
      accepted if the most recent has not landed. `banConfirmed` was already written for exactly this
      on the generator-restrictions page; it moved to `user-actions.service.ts` rather than being
      copied. Confirming *every* ban would take a full sweep to ~8 minutes — the checkpoint bounds the
      overlap and catches a wedged endpoint within 25 accounts.

- [ ] **A ban's fan-out is still unbounded, and the checkpoint cannot bound it.** `banConfirmed` polls
      `bannedAt`, which `toggleBan` writes FIRST — the model unpublish, media block, comment flagging,
      search-index removal and subscription cancels all run after it. So the confirmation returns while
      every one of them is still in flight, and Bulk Ban's checkpoint paces the loop without bounding
      what overlaps on the primary. It catches a wedged endpoint, which is the half worth having.

      The cheap version of the real thing: stamp completion at the END of the ban branch — a
      `banDetails.completedAt` on `User.meta`, a write that function is already making — and poll for
      that instead. Making the endpoint synchronous was the other option and does not survive 1000
      accounts at ~2s each.

- [x] **Should a message-pattern match HIDE the comment as well as report it?** **Decided 2026-08-24:
      report only.** The comment stays up, an automated report lands in the queue, and the author is
      told nothing. Hiding was the alternative — the link comes off the page immediately — and was
      declined while a false positive would be invisible with no route back (nothing clears the flag;
      see the one-way-door item below). Revisit if the queue cannot keep pace with a wave, and revisit
      it WITH that fix rather than instead of it.

- [ ] **User Lookup's enforcement actions are gated on the `/users` PAGE grant.** `contentAction` (bulk
      comment delete and ToS), `purgeContent` (irreversible) and `setBanned` all check
      `canAccess(user, '/users')` — a page grant standing in for a permission, which is the weld this
      app's own `CLAUDE.md` records as having cost the team once already. It was invisible while
      `/users` was an empty placeholder; it stopped being invisible the moment that page did something
      worth granting. Ticking a box that reads "let them see new signups" would have handed over mass
      comment deletion, ban and purge.

      Worked around for now by giving the new list its own path (`/users/newest`), which is a fence, not
      a fix. The fix is permission ids for the three actions — `user.ban`, `user.purge`,
      `user.comments.bulk` — resolved through `locals.grants` like every other action in the app.

- [ ] **There is no way back.** Setting `tosViolation` on a comment is a one-way door — nothing in the
      main app or the spoke clears it, and there is no comment equivalent of `restoreImages`. That was
      survivable while the flag did nothing on v2; now it is the removal, and a ban purge can set it
      across a whole account in one click. Filed in
      [`post-migration-backlog.md`](post-migration-backlog.md); it wants an unflag that also reopens the
      reports the ToS action closed.

---

# Carried forward from earlier rounds

Everything still open when this round opened, moved here so there is one live list. Each keeps the date
it was first raised.

## Contests *(08-21)*

Nothing below is built yet; each box carries what the code actually does today, because three of the
four have a root cause that is not what the symptom suggests.

- [ ] **`/moderator/contests` is a bare list and should be part of the suite.** It renders every
      `CollectionMode.Contest` collection newest-first with name, created-at, type and the submission
      window — and nothing that says whether a row is an official contest, a daily challenge or a
      user-made one. It predates user challenges entirely.

      The distinction is already in the data and needs no new field: a contest collection may have a
      `Challenge` row pointing at it (`Challenge.collectionId`), and `Challenge.source` is `System`
      (the auto-generated dailies), `Mod` or `User`. A contest collection with no `Challenge` row is a
      plain contest. So "kind" is a left join plus a case, and it is the column the page is missing.

      Port target: `/contests` in this app via
      [`moderator-page-migration`](../../.claude/skills/moderator-page-migration/SKILL.md) — a
      `NAVIGATION` entry, a Kysely load, filters on kind / status / window, and links out to both the
      collection and the challenge. **Unreachable until granted on `/admin`**, like every new page here.

- [ ] **Contest bans list caps at 20, and a new ban appears to do nothing.** Both symptoms are one bug.
      `/moderator/contests/bans` calls `user.getAll({ contestBanned: true })`, whose input extends
      `getAllQuerySchema` → `paginationSchema`, where `limit` is `.default(20)`. The page never passes a
      limit, so the query lands `LIMIT 20` and there is no total in the response to say what was cut.

      The "it didn't take" half follows from the same query: `getUsers` emits **no `ORDER BY`** unless a
      search term is present, so which twenty rows come back is whatever Postgres returns. A ban that
      succeeded lands somewhere arbitrary in a set larger than the window. The write is fine — the list
      cannot show it.

      Fix belongs in the port, not in a bigger `limit`: its own load, ordered by `bannedAt` desc, paged
      with a count, searchable, and with unban and edit-reason on the row.

      ⚠️ Latent while we are here: in `getUsers` the `ORDER BY` is spliced **into the middle of the
      `WHERE` clause**, before the `contestBanned` predicate. It is unreachable only because the
      contest-banned path never passes `query`; passing both would emit invalid SQL.

- [ ] **User Lookup shows no contest-ban flag.** `getUserLookup` already selects
      `u.meta #>> '{banDetails,reasonCode}'` and `{banDetails,detailsInternal}` off the same row, so
      adding `{contestBanDetails,bannedAt}` costs nothing extra. Render it as a badge in the pinned
      account-state column beside banned / muted — the column that exists precisely so a flag is not
      buried behind a long username.

- [ ] **Split contest bans: daily challenges vs everything else.** Most contest-banned accounts were
      farming Buzz on the daily challenge and may still compete fairly elsewhere, and today the ban is
      one flag with one meaning.

      `contestBanDetails` is JSON on `User.meta`, so this is a new optional `scope` on that object with
      absent meaning "everything" — existing bans keep today's behaviour, no backfill, and none of the
      additive-enum deploy ordering applies.

      There are exactly two enforcement points, and both need to read it:
      - `upsertCollectionEntry` (`collection.service.ts`) refuses any account carrying
        `contestBanDetails`. It would resolve the collection's kind first — the same `Challenge` join the
        list page needs — and refuse only within scope.
      - `loadBaseGates` (`contest-score.queries.ts`) folds every contest-banned id into
        `baseDisqualifiedIds`. That is the community-contest scorer, so it takes only the ids whose scope
        reaches contests.

      Open question for the reporters before this is built: is the axis two-valued (challenges /
      contests), or does an explicit "everything" state need to stay selectable in the UI rather than
      only being the legacy default?


## P0 — operational, nothing to build

- [ ] **Finish the environment and database steps** *(08-17)* — handover blockers
      [#1–#4](retool-migration-handover.md). `CIVITAI_MOD_API_KEY` is retired and must NOT be
      provisioned, and `RETOOL_DATABASE_URL` is retired too — the Retool and moderator databases were
      consolidated, so `MODERATOR_DATABASE_URL` is the only name. What remains is the `FRESHDESK_TOKEN`
      rename, and the SQL migrations: verify two of the original three, and apply the two added
      2026-08-24 (`20260824120000_user_email_domain_index`, which also needs `ANALYZE "User";`, and
      `20260824140000_comment_user_id_indexes`) everywhere except production, where both are live.
- [ ] **Tick the action grants on `/admin`, then check as a non-admin** *(08-19)*. There are no default
      roles, so until this pass happens the actions are held by nobody. The pass itself is
      [`action-grants-review.md`](action-grants-review.md). **Add Post Reports to it** — the new page is
      admin-only until granted.

## P1 — reported defects

- [ ] **Comment highlighting does not work on article comments** *(08-19)*. Read end to end and not
      reproduced from the code; needs a live repro with the URL in hand.
- [ ] **User Lookup unavailable for the staff role** *(08-17)*. Not a defect — part of the `/admin` pass.
- [ ] **`reportedUser` renders greyed out on reports** *(08-18)*. Suspected downstream of the above.
- [ ] **Comment rows are "funky" to read** *(08-18)*. Needs the reporter to say what is wrong.

## P2 — decisions

- [ ] **A paged list has no "load more"** *(08-19)*. Two panels have since been paged — the one fixed in
      the 08-19 round, and the account image grid (numbered paging, 08-21) — so the reporter needs to
      confirm which they meant rather than anything needing building.
- [ ] **`ReToolActions` vs `ModActivity`** *(08-17)* — two mod-action logs that nothing reconciles.
- [ ] **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** *(08-17)*.
- [ ] **How queue sweeps get tracked** *(08-17)* — a new table, or an extension of `ModActivity`.

## P3 — improvements, after parity

- [ ] **Show "recently worked" and "time sweeps" beside the queues they describe** *(08-17)*.
- [ ] **Whether the `/images/*` triage queues join the sweep tracking** *(08-17)*.
- [ ] **Link a report to the site it originated from** *(08-17)* — forward-only is possible via
      `Report.details`; the retroactive half is not.
- [ ] **The "Admin Attention" report reason is too vague to action** *(08-17)*.
- [ ] **The mod changelog modal disappears once a model is unpublished** *(08-17)*.
- [ ] **Unpublished articles have no republish path** *(08-17)*.
- [ ] **A model marked as depicting a minor can still receive a new version containing X-rated images**
      *(08-17)*.
