# Mod Studio feedback — rounds 2026-08-24 through 2026-08-28

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what these rounds asked for and whether it is done.

**Scope:** the comment-spam round raised on 2026-08-24, the follow-up round raised on 2026-08-25 after
that push and its changelog, the queue and strike-visibility reports raised on 2026-08-27, the Bulk Ban
round raised on 2026-08-28, PLUS everything still open from earlier rounds — in that order.

**This is the live list.** A round gets its own dated section so it is clear when something was first
asked for, and unfinished items move forward rather than being ticked across several files — so this is
the only file with open boxes. Earlier rounds:
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

## Round 2026-08-24

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
      The migration file now carries the step and how to confirm the plan changed.

      🔴 **The ANALYZE has now been run, on 2026-08-31, and it did NOT fix it.** This entry previously
      said the search was fixed the moment that step ran. That was a prediction, and it was wrong;
      leaving it would send the next person to a step already taken.

      What the ANALYZE did do: `pg_stat_user_tables.last_analyze` is set, and the index now has real
      statistics where it had none — `n_distinct` 3,876, a 200-entry MCV list and a 201-bound
      histogram. So the stated cause was real and is now removed.

      What did not change is the plan. Measured on the primary immediately after, on a domain with no
      accounts at all — the case Bulk Ban is actually used for, since it exists for disposable domains:
      still `Parallel Index Scan Backward using "User_pkey"` with the expression as a filter, still
      estimating **58,070** rows for a value with **zero** matches, **16.5 s** and 12.5M buffers to
      return nothing. The expression in the plan's `Filter` is character-for-character the index's own
      definition and the partial predicate matches, so this is not the rewording hazard above.

      ⚠️ A common domain is the WRONG test and will read as success. `qq.com` has 565,759 live
      accounts, so walking the primary key backward finds 500 of them in ~370 ms and the planner is
      right to do it. Only a rare domain shows the defect. The first measurement here was taken on a
      common one and briefly looked fine.

      So the estimate is the thing to chase: with an MCV list and a histogram in place, a value absent
      from both should estimate near zero rather than 58,070, and that number did not move before and
      after. **Still open**, with the cheap explanation now eliminated rather than assumed.

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

- [x] **"Comment Spam Identifier" from Retool.** It is Retool's **"Comment Spammer"** alert in User
      Lookup's Quick Info, backed by `PotentialSpammerV2`, and it was ported here as `getCommentBurst`
      — so the earlier claim in this file that it "is not in anything we have" was wrong. What replaced
      it is a rule measured against the wave rather than Retool's.

      🔴 **Retool's alert never fired, in any state.** Its visibility expression was
      `!total_comment_count < 20`, and `!x` evaluates to a boolean first — so both branches yield
      `true` and `hidden` was a tautology. It has been invisible since 2023. That is the actual answer
      to "nobody is sure what it should measure": nobody had seen it. There is no Retool behaviour here
      to be faithful to, which is what licensed replacing the rule outright.

      **The rule, measured over 90 days of comment events against ban outcomes:**

      | rule | accounts | banned |
      | --- | --- | --- |
      | ≥10 comments in an hour, any age | 1,086 | 76.5% |
      | **≥10 comments in an hour, account < 2 days old** | **837** | **98.9%** |
      | ≥10 comments in an hour, account ≥ 2 days old | 249 | **1.2%** |

      **The account's age is the rule, not a refinement.** A volume-only version points at 249
      established accounts having an argument.

      🔴 **An earlier version of this entry claimed the wave posted "11 comments on 11 distinct targets,
      no thread twice". That was an artifact, not a measurement.** The ClickHouse `comments` table
      records `entityId` as the COMMENT's own id for every type except `Model` — verified over 7 days:
      Image 18,717 rows / 18,700 "distinct", Comment 5,950 / 5,943, against Model 8,987 / 3,261. So a
      distinct-target count is the comment count restated, and `targets >= 10` was `comments >= 10`
      written twice. It has been removed from the rule and from both screens, which were stating it to
      moderators as fact. Recovering a real distinct-target signal needs the tracker fixed — filed in
      [`post-migration-backlog.md`](post-migration-backlog.md).

      **Built, and the same rule on both surfaces:** a badge at the top of User Lookup's Basic section
      (where Retool had it), and a list at `/users/newest?view=spam` covering 24h / 7d / 30d, with
      already-banned and deleted accounts left out because it is a queue of things to do. Both read
      ClickHouse — moderators delete the comments when they ban, so Postgres cannot answer for anyone
      already actioned: of the 1,002 accounts in the 2026-08-24 wave, **two comments survive**.

      The cap is applied **after** the exclusions, which is not a detail: capping first returned 200
      rows that were all already-banned wave accounts, so the page said "nothing matches" during the
      wave it exists for.

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

- [x] **A ban's fan-out is still unbounded, and the checkpoint cannot bound it.** `banConfirmed` polled
      `bannedAt`, which `toggleBan` writes FIRST — the model unpublish, media block, comment flagging,
      search-index removal and subscription cancels all run after it. So the confirmation returned while
      every one of them was still in flight, and Bulk Ban's checkpoint paced the loop without bounding
      what overlapped on the primary. It caught a wedged endpoint, which is the half worth having.

      **Done 2026-08-31, the cheap version as filed.** `toggleBan` stamps `banDetails.completedAt` as
      the LAST statement of the ban branch, and `banConfirmed` polls that. Making the endpoint
      synchronous was the other option and does not survive 1000 accounts at ~2s each.

      Three things load-bearing enough to name:

      - **Being last is the whole value.** A stamp written anywhere else in the branch reads as a bound
        while bounding nothing, and no caller can tell. `ban-completion-stamp.sql.service.test.ts`
        asserts its POSITION against the last `await` in the branch, not its presence.
      - **`jsonb_set`, not another `updateUserById`.** The fan-out takes seconds; a read-modify-write of
        `meta` here would clobber whatever else was written to that column while it ran. Guarded on
        `meta -> 'banDetails' IS NOT NULL`, since `jsonb_set` needs the parent object to exist and an
        unban wipes it.
      - **The poll budget went from 6 attempts to 20.** Six was sized for a write that happens first;
        the stamp lands after the expensive half.

      🔴 **Deploy the main app FIRST.** An older `toggleBan` never writes `completedAt`, so the spoke
        would report every ban unconfirmed and Bulk Ban would stop with a 502 at its first checkpoint.
        There is deliberately no fall back to `bannedAt`: from the spoke a missing stamp is
        indistinguishable from a fan-out still in flight, and falling back would silently restore the
        unbounded behaviour this exists to end. The stamp is additive and harmless to ship alone.

- [x] **Should a message-pattern match HIDE the comment as well as report it?** **Decided 2026-08-24:
      report only.** The comment stays up, an automated report lands in the queue, and the author is
      told nothing. Hiding was the alternative — the link comes off the page immediately — and was
      declined while a false positive would be invisible with no route back (nothing clears the flag;
      see the one-way-door item below). Revisit if the queue cannot keep pace with a wave, and revisit
      it WITH that fix rather than instead of it.

- [x] **User Lookup's enforcement actions are gated on the `/users` PAGE grant.** `contentAction` (bulk
      comment delete and ToS), `purgeContent` (irreversible) and `setBanned` all check
      `canAccess(user, '/users')` — a page grant standing in for a permission, which is the weld this
      app's own `CLAUDE.md` records as having cost the team once already. It was invisible while
      `/users` was an empty placeholder; it stopped being invisible the moment that page did something
      worth granting. Ticking a box that reads "let them see new signups" would have handed over mass
      comment deletion, ban and purge.

      Worked around at the time by giving the new list its own path (`/users/newest`), which was a
      fence, not a fix.

      **Done 2026-08-31.** The three ids exist and the actions are `requiresGrant('user.ban')`,
      `requiresGrant('user.purge')` and `requiresGrant('user.comments.bulk')` — the same shape the four
      already-converted actions on that page use (`user.identity.edit`, `user.moderator.toggle`,
      `user.cosmetics.grant`, `user.buzz.send`). Three ids rather than one because they are three
      decisions: a role can reasonably clear comment spam without being able to end an account, and
      `user.purge` is the only one with no way back.

      The UI moved with the server, or the fix would only relocate the confusion: the Ban/Unban and
      Purge buttons now render on `data.grants['user.ban']` / `['user.purge']`, and `CommentList`'s
      bulk controls on `['user.comments.bulk']` — that prop is renamed `canBulkAct`, since `canAct`
      now means something different from what gates it.

      `canAct` still comes from the `/users` page grant and still means "may open the enforcement UI".
      That is the correct remaining use of a page grant; the defect was it standing in for the
      permission underneath. Sixteen other actions on this page are still on `canAccess('/users')` —
      identity, socials, profile, notes and the rest — and were left alone: this item was about the
      three that end an account.

      Nothing is held by anyone at first, which is the design rather than a cutover risk:
      `resolvePermissions` short-circuits on `moderator:admin`, so admins hold every new id on deploy
      and grant the rest from `/admin`.

- [ ] **There is no way back.** Setting `tosViolation` on a comment is a one-way door — nothing in the
      main app or the spoke clears it, and there is no comment equivalent of `restoreImages`. That was
      survivable while the flag did nothing on v2; now it is the removal, and a ban purge can set it
      across a whole account in one click. Filed in
      [`post-migration-backlog.md`](post-migration-backlog.md); it wants an unflag that also reopens the
      reports the ToS action closed.

---

# Round 2026-08-25

Reported after the 08-25 push and its changelog. Kept in this file rather than a new dated one so
there is still exactly one list with open boxes; each item carries the date it was raised.

## Reported defects

- [x] **Most reported: pressing "Actioned" fails.** *(08-25)* The write was never the problem. Two
      things compounded: `getMostReported` filters `status = Pending` but is cached for 60 s, so a
      report someone else resolved — or that a ban purge closed — keeps rendering for up to a minute,
      and clicking it hits `setReportStatus`'s `where status != status`, which answers **409 "Someone
      else already actioned that report"**. The dashboard then threw that message away: `actionReport`'s
      `enhance` handler treated every non-success alike and printed **"failed — retry"**, so a row that
      could never succeed asked to be retried forever. A missing `/reports` grant landed in the same
      place with the same unreadable text.

      The dashboard now renders what the server actually said, and on a 409 drops the row instead of
      marking it failed — retrying it cannot work, and the empty state below the table already handles
      the list emptying out. `outcome` carries the message with the verdict rather than a bare
      `'failed'` string.

      The 60 s cache is left alone: shortening it trades a stale row nobody can action for a ~200 ms
      six-table join on every dashboard load, and the stale row is now self-clearing.

- [x] **Images → Appeals loads nothing, then goes black.** *(08-25)* **A duplicate row, not a render
      bug.** Reproduced against production on 2026-08-27; the browser console named it exactly:

      ```
      each_key_duplicate — Keyed each block has duplicate key `140920383` at indexes 9 and 10
        in ImageQueueGrid.svelte
      ```

      `getAppealImageQueue` reached `ModActivity` with a plain `leftJoin` on
      `entityId`/`entityType`/`activity` and **no LIMIT**. That table holds one row per review, and an
      appealed image has been reviewed at least once and usually more — so the join returned the image
      once per review. `ImageQueueGrid` keys its `{#each}` on the image id, so the second copy threw and
      Svelte tore the page down mid-render. That is the black screen, and it is also why the sidebar link
      "did nothing": on a client-side navigation the same throw aborts the render while leaving the
      previous page on screen.

      Two things worth keeping from the diagnosis. The duplicate landing at **adjacent** indexes 9 and 10
      is the signature of a fan-out — the copies sort together under `ORDER BY i.id DESC` — so that
      detail is diagnostic, not incidental. And **this file had already learned the lesson**: the
      `ImageConnection` join twenty lines up carries a comment explaining that a multiply-matching join
      duplicates rows and breaks cursor paging, and uses `LATERAL … LIMIT 1` for exactly that reason.
      The appeal query used the pattern for its `Appeal` join and not for this one.

      Fixed as a `leftJoinLateral` ordered `createdAt desc, limit 1` — the ordering is load-bearing,
      since the card reads "Removed … by X" and an unordered `LIMIT 1` credits an arbitrary moderator.
      Covered by `appeal-queue-sql.test.ts`, which compiles the real query against a driver that never
      connects and asserts `ModActivity` is unreachable except through a capped lateral. Mutation-checked:
      restoring the original join fails two of its three tests.

      **Also changed: the appellant join is `leftJoin`, not `innerJoin`.** It now agrees with the item
      type (`username: string | null`) and the card's `[deleted] #id` fallback — both already written for
      a left join — and stops a future hard-deleted account from silently dropping an appeal out of the
      queue.

      ⚠️ **Defensive, not a fix for anything happening now. Measured rather than assumed.** The sidebar
      badge is `Image WHERE needsReview = 'appeal'` and joins nothing, so in principle it can count rows
      the list cannot render. On production on 2026-08-27 it does not: of **137** flagged images, **137**
      have an `Appeal` row, **0** have a deleted appellant, and all 137 are `Pending`. Badge and queue
      agree exactly, there is no backlog of unrulable appeals, and nothing needs cleaning up.

      So there is **no `needsReview` work item here.** The divergence is a property of the two queries,
      not a state the data is in — worth knowing only if the badge and the list ever disagree.

      **A sweep for the same shape found nothing else.** Every other join in `image-review.service.ts` is
      on a primary key; `getReportedImageQueue` fans out deliberately and keys on report id; and
      `image-tags.service.ts` already guards its CTE with `SELECT DISTINCT "imageId"`. Appeals was the
      only one.

- [ ] **Mod Studio bounces to civitai.com after switching user on .red.** *(08-25)* Reported as "Lookup
      user takes me to civitai.com", then narrowed by the reporter: switching account on `.red` switches
      it on `.com` too, and switching back on `.red` does not switch back on `.com`. The split is
      deliberate — `civitaiLinkUrl()` is `.red` for links a moderator follows, `civitaiAppUrl()` is
      `.com` because the relayed session cookie is issued for `.civitai.com`, and it is also the redirect
      target for an authenticated non-moderator. So a session that reads as non-moderator to the spoke
      lands the moderator on `.com`, which is exactly the symptom. Confirm against a real switch before
      deciding whether the fix is the cookie scope or the redirect.

      **Found since:** the redirect is `hooks.server.ts`'s `NON_MODERATOR_REDIRECT = civitaiAppUrl()`,
      returned as a 303 on a `forbidden` verdict. That is the **API base** standing in for a link a human
      follows — `civitai-url.ts` says so in as many words, and names `civitaiLinkUrl` as the other
      decision — so the destination half of "it takes me to civitai.com" is a one-line defect,
      independent of whatever made the session read as non-moderator in the first place.

      **Deliberately not changed yet.** Swapping the constant relocates the dead end without fixing being
      locked out, and changing it before the cause is known makes the remaining bug harder to see. It
      also decides where a genuine non-moderator lands, which is not what either constant is named for.
      *Closes when:* a moderator who switches account on `.red` reaches Mod Studio without being
      redirected, verified by the reporter — with the redirect target settled at the same time.

- [x] **A ToS'd v2 comment shows moderators nothing on-site.** *(08-25)* v1 rendered an orange
      `IconExclamationCircle` for moderators when `comment.tosViolation` was set
      (`src/components/Model/ModelDiscussion/CommentDiscussionItem.tsx:124`) and
      `CommentsV2/Comment/Comment.tsx` rendered no equivalent — `tosViolation` there only hid the
      "Remove as ToS violation" menu item — so on every v2 surface a moderator could not tell a removed
      comment from a live one. v2 now carries the same badge, beside the pinned icon in the comment
      header, same icon and same tooltip so the two surfaces read alike.

      **Not covered by a test.** The only browser test that mounts this tree
      (`AppListingComments.browser.test.tsx`) mocks `Comment` out entirely, and standing up
      `CommentsProvider` + `CommentProvider` + trpc + `useCurrentUser` to assert one badge buys less
      than it costs. Worth knowing rather than assuming.

- [ ] **Confirm the orphan thread line is gone.** *(08-25)* A ToS'd reply vanished for signed-out viewers
      but its parent kept the reply indicator. `Comment.tsx` draws `repliesIndicator` on
      `replyCount > 0`, and both count paths — the `groupBy` that seeds it and `getCommentCount` —
      exclude `tosViolation` for non-moderators as of **0589461b97** *(fix(comments): stop ToS-removed v2
      comments from being counted, #4430)*, which landed the day after the report. Ticking this needs the
      signed-out re-check, not another read.
      *Closes when:* the reporter re-checks a ToS'd reply from a logged-out browser and sees no line.

- [x] **Say which timezone a timestamp is in.** *(08-25)* **Answered, not fixed.** The zone is the
      **viewer's own local zone** — `$lib/format.ts`'s `dateTime` is
      `toLocaleString(undefined, { dateStyle, timeStyle })`, which resolves against the browser, and the
      five one-off formatters elsewhere (`articles/ratings`, `audit/prohibited-prompts`,
      `audit/scanner-audit/[mode]`, `reports/[slug]`, `retool/queue-stats`) all do the same. So two
      moderators in different countries read the same row differently, and nothing on screen says so.

      **Decided 2026-08-27: both, in the text.** `dateTime` now renders local time with its zone named
      and the UTC equivalent after it — "Aug 25, 2026, 4:15 PM EDT (20:15 UTC)". Local is what matches
      the moderator's own clock; UTC is what matches logs, ClickHouse and everyone else. The suffix is
      dropped for a viewer already on UTC, where it would restate the line.

      **In the text rather than a `title` tooltip** — this team reports by screenshot, and a tooltip does
      not appear in one. That is the whole reason the cheaper option was not taken.

      Three of the five one-off formatters (`articles/ratings`, `audit/scanner-audit/[mode]`,
      `reports/[slug]`) now call `dateTime` instead of their own `toLocaleString`, so the answer is the
      same on those pages too. Two are deliberate exceptions: `audit/prohibited-prompts` is time-only and
      all from today, so it gained the zone but not the date or the UTC suffix, which would repeat down
      every row; and `retool/queue-stats` formats **chart axis labels**, where a zone on every tick is
      noise — that chart still needs its zone said once in its caption.
      The queue-stats chart now names its zone once in the page header — "Times below are in your local
      timezone (Europe/Berlin)" — rather than per tick. **Done.**

- [ ] **Changelog wording: "Strikes — 1 point nothing happens".** *(08-25)* **The reporter is right, and
      the code confirms it.** `createStrike` fires a `strike-issued` notification and sends
      `strikeIssuedEmail` on **every** strike, before any points arithmetic — neither is behind a points
      threshold, so a 1-point strike notifies exactly like any other. What is gated on points is
      escalation (`evaluateStrikeEscalation` → mute/flag at `MUTE_POINTS` / `REVIEW_MUTE_POINTS`), which
      is what the line was trying to say. It should read "nothing FURTHER happens".

      One real caveat found while checking: `createStrike` returns `null` early for a rate-limited strike
      — max one per user per day — and that path sends neither notification nor email. It applies only to
      **auto** strikes; a moderator-issued strike is `ManualModAction` and skips the limit, so it cannot
      hit a moderator by hand.

      What is left is the copy, and it lives in the changelog artifact rather than this repo, so whoever
      owns that link has to edit it.
      *Closes when:* the changelog line says "nothing further happens".

## Decisions

- [ ] **Reopened: should a blocklist match on a comment HIDE it, not just report it?** *(08-25)* Declined
      on 08-24 as report-only (the decision is above). The counter-argument from the mod team:
      report-only still needs a human before the content comes off the page, so obscene or spam content
      posted at 04:00 stays visible until someone wakes up — which is the thing the blocklist exists to
      prevent. Proposed middle ground: hide the comment from everyone except moderators until one
      confirms or denies it, with the author told nothing, so a spam run cannot learn which word tripped
      it.

      This is the same trade the 08-24 decision turned down, so rule on it **with** the unflag path above
      rather than instead of it — a false positive that nothing can clear is what made hiding the worse
      option.
      *Closes when:* the person who took the 08-24 call rules on the hide-from-non-moderators variant, in
      this file.

- [x] **A "no linked content" report gives a moderator nothing to judge.** *(08-25)* The label was
      honest — `entity === 'other'` means no row in any of the fifteen report tables — but the row
      offered only **Actioned** and **Dismiss** with nothing to base either on. `Report.details` is the
      reporter's own free-form fields and survives the content being deleted, so it is the one thing
      left to rule on; the query now carries it and unlinked rows render it under the label. A report
      that has no details either says so and tells the moderator to dismiss it, rather than leaving them
      to guess which button is right.

      Only unlinked rows render it. Every other row links to the content, where the details already
      show — repeating them on the dashboard would be noise on nineteen rows out of twenty.

      `detailEntries` moved out of the images queue into `$lib/reports` as `reportDetailEntries`; it was
      already used twice in that one file and this would have been the third copy.

## Found while in there *(08-27)*

- [x] **The error page was the least legible thing in the app.** Nobody reported this, and it is why the
      Appeals report could not say more than "black screen". The status code rendered `text-6xl` in
      `text-dark-4` (`#373a40`) on the `#1a1b1e` background — roughly **1.6:1** — inside a
      `min-h-[60vh]` centred grid, so depending on scroll position a real 500 presented as an empty dark
      page. The one screen whose entire job is naming a failure was the one hiding it. Now `text-dark-2`
      (~5.2:1), the app's own muted token, so the next outage reports itself.

## Improvements

- [x] **Link a model back to the account that trained it.** *(08-25, three reporters)* The abuse shape,
      as reported: train on ToS-breaking data, leave the model in draft on the main account, re-upload it
      from a burner with no IP link and tamer preview images. The training id was still in the metadata,
      which is the only reason the origin account was found — by hand, through a second person. The data
      exists, and **both halves of the lookup are already built — pointing opposite ways.**

      - **workflowId → model.** `/audit/training-models` already filters on
        `mf.metadata->'trainingResults'->>'workflowId'`. Give it a training id and it finds the model.
      - **user → workflowId.** `getTrainingOrchestration(userId)` reads ClickHouse `buzzTransactions`
        `WHERE type = 'training' AND fromAccountId = <id>`, taking `details.workflowId` off each charge.

      What is missing is one query and a comparison: invert that second one to
      `WHERE type = 'training' AND JSONExtractString(details, 'workflowId') = <id>` returning
      `fromAccountId` — workflowId → the account that PAID — then compare against `Model.userId` and badge
      the mismatch. Same table, same column, filter swapped.

      🔴 **Scope it honestly before building.** It reads the workflow id off the model's own training
      file, so it catches the careless case the reporter described — metadata left intact — and nothing
      else. Someone who strips it, or who uploads a bare safetensors with no training file at all, leaves
      nothing on the model to join on, and this finds them no better than today. Worth casting anyway,
      because the abuse it does catch is invisible right now — but it is not a closed door.

      Note what it does **not** need — the dataset itself is still unrecoverable, and nobody asked for it
      back. The id is enough.

      **Built 2026-08-27.** `training-provenance.service.ts` inverts that charge query, and the training
      data review page (`/audit/training-data/<versionId>`) now says who paid for the run under the
      "Uploaded by" line, badging **Trained by another account** when payer and uploader differ.

      Three things worth knowing about how it behaves:

      - **The window is the cost, so the workflow id pays it.** `buzzTransactions` has no index on
        workflow, and the service this inverts measures 19.1s over 912 days against 0.7s over 7. The id
        carries its own submit second, so the lookup is bounded to ±2 minutes around it. A test asserts
        those bounds are in the emitted SQL — dropping them fails rather than quietly scanning history.
      - **An outage is never reported as agreement.** ClickHouse being unreachable returns
        `reachable: false`, rendered as "could not reach the charge history", not as "same account". That
        is the one wrong answer that would be invisible.
      - **Its own endpoint, not the list load.** One query per workflow, so folding it into
        `/audit/training-models` would run one per card.

      Seven tests, two of them mutation-checked: dropping the window bound and reporting an outage as
      reachable each fail loudly.
      *Closes when:* a moderator confirms it against a real re-upload — the shape has never been run
      against the account that prompted the report.

# Round 2026-08-27

## Reported defects

- [x] **Strikes are barely visible, and a recent one reads as expired.** *(08-27)* One report, three
      independent causes — none of them the strike badge the reporter was looking at. All three are
      fixed; the two that were decisions were ruled on the same day, and what was decided is recorded
      under each.

      **1. No strike has ever appeared in moderator activity, and none can.** `createStrike`
      (`src/server/services/strike.service.ts:608`) writes a `UserStrike` row, evaluates escalation,
      notifies and emails — and writes **no `ModActivity` row at any point**. `getModActivity` reads
      `ModActivity` and nothing else, so the panel is not failing to show the strike; the strike was
      never in the table it reads. Retool-era strikes can surface in the *other* panel,
      `getRetoolActivity`, because `ReToolActions.ActionType` happens to contain free text like
      `Strike 2 on user <id>` — a different table, a different era, and matched by regex rather than
      recorded. So which strikes a moderator can attribute depends on when they were issued, and the
      strike list itself is a third place again. This is the
      [`ReToolActions` vs `ModActivity`](#p2--decisions) P2 item arriving as a symptom.

      **2. The list fetches who issued it and throws it away.** `getLiveStrikes` selects `issuedBy`;
      `StrikeList.svelte` renders reason, description, points and dates and drops it. For imported rows
      it is worse than a display gap: `migrate-legacy-strikes.ts` sets `issuedBy` **only on an exact
      username match**, deliberately, since a fuzzy match would credit the wrong moderator — the legacy
      `createdBy` display name survives instead inside `internalNotes`
      (`retool:UserStrikes:<id> by <name>`), which no panel shows. Measured against production on
      2026-08-27: **8,901 of 12,902** imported rows have `issuedBy = NULL` (69%), against **0 of 63**
      native ones. So "I'll assume it was me" is the only reading available for two thirds of the
      history, and the name that would answer it is already stored.

      **3. "Expired" on a week-old strike is the import boundary, not a bad badge.** The 08-21 import
      lands every legacy row `status = 'Expired'`, `points = 0`, `expiresAt = createdAt`, and that is
      the correct call for the bulk of them: importing ~12.9k historical strikes as Active would have
      handed out mutes at `REVIEW_MUTE_POINTS` off evidence up to four years old, each with its own
      notification. It is the wrong call for the last fortnight of Retool. The newest imported row is
      dated **2026-08-18**, three days before the import ran; on production **438** imported strikes
      carry a `createdAt` inside the last 60 days and **all 438** read Expired with 0 points, **75** of
      them within 14 days. A strike issued days before the cutover therefore presents as spent history
      *and* counts nothing toward the next escalation — which is the more expensive half, because it is
      invisible on the screen where the next action is decided.

      Native strikes are unaffected: `expiresInDays` defaults to 365 (`strike.schema.ts:37`) and no
      native row is Expired.

      **Cause 2 is fixed.** `getLiveStrikes` left-joins `User` on `issuedBy` and falls back to the
      legacy display name, parsed out of the import marker by `legacyStrikeIssuerName` in the shared
      `legacy-strike-import.ts` — the protocol file both sides already import, so the writer and this
      reader cannot drift. `StrikeList` renders "by <name>", or **"issuer not recorded"** where neither
      exists: an absent issuer now says so instead of looking like a formatting gap. `internalNotes` is
      read for the name and dropped in the service; the rest of that field is a moderator's free text and
      no panel shows it. Three tests, mutation-checked — a naive split on the separator truncates a name
      containing " by " and fails.

      The first-pass marker (`Imported from Retool strike #<id>. Issued by: …`) is deliberately **not**
      parsed for a name: no production row carries it, so guessing its shape risks crediting the wrong
      moderator.

      **Cause 1 — decided: strikes are logged.** `createStrike` now calls `trackModActivity` with
      `entityType: 'user'`, `activity: 'strike'`, `entityId` the struck account and `userId` the issuer
      — the `-1` sentinel for an auto-strike, matching `entity-moderation.ts`, so a cron is never
      recorded as an account. It is outside `RATING_ACTIVITIES`, so it lands in the enforcement bucket
      `getModActivity` already renders; no spoke change was needed.

      **The write is deliberately non-fatal.** The strike row is committed before it runs, so throwing
      would report a failure for a strike that landed — and the moderator's retry issues a *second*
      one, because `ManualModAction` skips the rate limit. It logs `strike-mod-activity-failed` to
      Axiom instead, the same shape as the email block above it. Three tests, mutation-checked:
      attribution, the sentinel, and that a failed write does not fail the strike.

      Only issuance is logged. **Voiding a strike still records nothing** — the same argument applies to
      it and it was not part of the call, so it is named here rather than assumed.

      ⚠️ **One environment-shaped hazard, inert where it matters.** `trackModActivity`'s
      `ON CONFLICT DO NOTHING` carries no target, so anywhere `20260805120000_mod_activity_append_only`
      has not been applied by hand, the unique index on (activity, entityType, entityId) silently
      discards the second and every later strike against the same account — the panel would show only
      the first. The index is confirmed gone on production and dev, so nothing is losing rows today.
      It is worth knowing because migrations here are applied per environment by a human, and `strike`
      is the first genuinely repeatable-per-entity activity in this union; the neighbouring
      `reactionAbuseExclude`/`Unexclude` pair are toggles, which is why nobody has hit it.

      **Cause 3 — decided: re-label, and label every imported row, not just the recent ones.** Nothing
      is re-dated: that would run escalation retroactively on accounts nobody re-reviewed, which is the
      outcome the import was shaped to avoid. `LiveStrike` now carries `imported`, and the badge reads
      **imported** ahead of the lapsed check — every imported row *is* lapsed, since the import sets
      `expiresAt = createdAt`, and "expired" claims the strike ran its course. Nothing is lost by the
      substitution: all 12,902 imported rows carry `reason = 'ManualModAction'`, which is what the badge
      would otherwise have shown.

      It covers all 12,902 rather than the 438 recent ones, because "expired" was never the right word
      for a 2022 row either — and a cutoff would need a date nobody could defend. Where any row is
      imported the list says once, above it, that imported strikes are Retool-era history carrying no
      points — in the text rather than a tooltip, for the same reason the timezone answer above is:
      this team reports by screenshot.

      ⚠️ **The flag is `legacyStrikeId`, deliberately not `importedLegacyStrikeId`.** The union of both
      markers is right for the dedupe callers and wrong for this badge: only the 08-21 pass lands a row
      inert, while a **first-pass** row is `Active` with a point and counts on the escalation ladder. A
      first-pass row badged "imported" would hide its real reason under a note saying it carries none,
      while `getActiveStrikes` went on counting the point — under-reporting live points on the screen
      where the next strike is decided. No production row carries that marker today, so this was
      structural rather than live, but the two predicates mean different things and the wrong one was
      reachable by a documented rollback.

      Caught by the correctness review, along with one inert negative test: `legacyStrikeIssuerName`'s
      only defence against parsing a moderator's own note is the marker check, and all three original
      negatives passed without it — none of them contained the separator. `Removed 3 images by hand`
      does, and now fails when the guard is dropped. The mapper is a named export (`toLiveStrike`) with
      four tests, because the property that matters most has no other check: `internalNotes` is read
      for the legacy name and must not leave the server, and nothing in the type system notices it
      being put back.

      One known property, left alone rather than hardened: the parser returns everything after the
      first ` by `, unbounded. Nothing updates `internalNotes` after creation, so the tail is always
      the name — but if anything ever appends to an imported row's notes, that text becomes the
      client-visible "by …" string.

- [x] **Bulk Image Manager loses the selection when you page.** *(08-27)* Ticking images, pressing
      **Next** and finding the previous page unticked — so a ToS sweep could only be done one page at a
      time. Fixed in **566b09c08f** *(fix(moderator): keep an image selection across pages in Bulk Image
      Manager)*. The reporter had already narrowed it themselves: the user-report removal tool keeps its
      selection correctly and the User Lookup one did not, which is where to look when this shape
      recurs.

- [x] **Actioned reports come back on the dashboard.** *(08-27)* "I action, hit refresh, see something
      else — refresh again and the ones I initially actioned are back." Fixed in **89e18fe73a**
      *(fix(moderator): stop actioned reports coming back on the dashboard)*. Related to, but not the
      same as, the 08-25 "pressing Actioned fails" item above — that one was a 409 rendered as "failed —
      retry"; this one is the row reappearing after a successful write.

- [x] **A long report detail shoves the dashboard columns sideways.** *(08-27)* Reported as "long comment
      caused the reason and rightwards to move over instead of spacing it down", and reproduced exactly:
      the comment does not wrap, the table overflows, and Reason / First reported / By are pushed off the
      right edge.

      **The cause is one inherited property, and my first two guesses were both wrong.** `TableCell`
      applies `whitespace-nowrap` to EVERY cell, and `white-space` inherits — so it reaches the details
      block and no value can wrap at all. It has nothing to do with the value's shape; an ordinary
      sentence does it. The fix is `whitespace-normal` on that block.

      🔴 **`break-words` does not finish the job, and looks like it does.** Production also carries a
      640-character run with no whitespace, and `overflow-wrap: break-word` leaves it overflowing:
      it only breaks a word that overflows its LINE BOX, and an auto-layout table cell grows rather
      than overflowing, so the break never triggers. `overflow-wrap: anywhere` (Tailwind
      `wrap-anywhere`, needs v4.1+; this app is on 4.3.2) participates in min-content sizing, so the
      cell can shrink and the token wraps. Measured side by side rather than reasoned: `break-words`
      wrapped the sentence and left the token overflowing in the same screenshot.

      Timeline worth keeping: unlinked rows only started rendering `details` on 08-25, as the fix
      for
      "a no linked content report gives a moderator nothing to judge" above. This is that feature's
      first long value, two days later.

      ⚠️ Verified against a standalone reproduction using `TableCell`'s own classes, NOT the live
      page — the local login could not be re-established. The mechanism and both candidate fixes are
      measured; the dashboard itself has not been seen with this change on it.

- [ ] **"Dashboard being funkeh" — a screen recording nobody has read back.** *(08-27)* Posted as a
      video with no description, twenty minutes after the actioned-reports report above and after a fix
      had been deployed, so it may be that same bug, its fix not yet live, or a third thing. Recording
      it rather than guessing: a video in a chat log is evidence only for as long as someone remembers
      it exists.
      *Closes when:* the reporter says in one line what the recording shows, or confirms it was the
      actioned-reports bug now fixed in **89e18fe73a**.

- [x] **User Lookup 500s after a deploy.** *(08-27)* Reported and fixed inside the hour by the deploy
      that followed it; the reporter did not raise it again. Recorded because a 500 on the app’s most
      used page is worth having in the history, not because anything is outstanding.

# Round 2026-08-28

## Reported defects

- [x] **Bulk Ban's IP search shows the 500 OLDEST accounts, and calls that number the total.**
      *(08-28)* Reported as "only pulls the 500 oldest accounts registered", which is exactly right,
      and the cause is one line: `getAccountsOnIps` ends `ORDER BY targetUserId LIMIT 500`. Account
      ids ascend with age, so the cap keeps the oldest registrations and drops everything newer.

      Measured against ClickHouse on 2026-08-28, on the IP the reporter checked: **908** accounts
      registered on it, **500** shown, **408** hidden. The visible list stops at a registration from
      **2025-04-26** and the hidden ones run from **2025-04-27 to today** — the most recent is hours
      old. So sixteen months of a still-active ring are invisible, and it is the *active* half that
      is invisible.

      Three separate defects behind one symptom, worth separating because they need different fixes:

      **1. The cap is real and should stay.** The service comment gives the reason: an IP behind a
      carrier NAT can carry thousands of unrelated registrations, and a moderator must not be handed
      that as a ban list. Nothing below argues for removing it.

      **2. The order is backwards for the job.** Oldest-first is what a cap should never keep on a
      list whose purpose is stopping a ring that is still registering accounts. Newest-first costs
      nothing and inverts which half survives the cap.

      **3. The truncation is not merely silent — the UI states it as a fact.** The panel header
      renders `Accounts on those IPs ({data.ipAccounts.length})`, so a capped result reads
      **"Accounts on those IPs (500)"**: a definite count that is really the cap. This is the exact
      trap already flagged on `getLiveStrikes` ("`limit` truncates silently, and `SuspectPanel`
      renders a count from `.length` — at 50 rows that count would read as the cap"), in a second
      panel. The "Add 500 to the list" button below it inherits the same wrong number.

      **And the cap is unreachable by working it.** `getAccountsOnIps` does not exclude accounts that
      are already banned, so banning the visible 500 and re-running returns *the same 500*, now all
      banned. There is no sequence of actions in the UI that reaches the other 408. Its sibling
      `getAccountsOnDomains` does filter `bannedAt IS NULL AND deletedAt IS NULL`, so the domain
      search drains as you work it — the two queries are otherwise the same shape, and that one
      difference is what makes this one a dead end rather than a page size.

      ⚠️ **`getAccountsOnDomains` has the same ordering defect** — `orderBy('id')` with the same 500
      cap, and the same `.length`-derived header. It self-drains, so it is a slower dead end rather
      than a permanent one, but a domain with more than 500 live accounts shows the oldest of them
      first for the same reason.

      **Fixed 2026-08-28, and the decision on the judgement call was MARK, not hide.** Banned accounts
      stay in the IP list wearing a badge. Filtering them would make the list drain as it is worked,
      which is the cheaper fix — but it would also hide that a ring has been actioned before, and that
      is a thing the panel is read for.

      🔴 **Marking is exactly why the panel had to gain PAGING, and the first version of this fix did
      not.** Filtering is what makes a cap survivable: ban the visible rows, re-run, get the next ones.
      Marking removes that, so ordering newest-first only changed WHICH 408 accounts were invisible —
      ban the 500, re-run, and the identical 500 come back badged with "Add 0 to the list", and the rest
      of the ring is unreachable by any sequence of actions in the UI. The panel also told the operator
      to "narrow the IPs to see the rest", which cannot be done when the search is one IP, which is the
      reported case. That was the original bug relocated, not fixed; the correctness review caught it and
      an earlier draft of this entry asserted the opposite. The two decisions are a pair — keeping the
      marking without the paging is the state that reads as fixed and is not.

      Three changes to `getAccountsOnIps`:

      - **`ORDER BY time DESC`**, on `min(time)` rather than on the id. Verified against production:
        the same IP now returns registrations from today first, where the old order stopped at
        2025-04-26.
      - **A second `uniqExact(targetUserId)` query** carrying the same predicates, so the panel renders
        "500 of 908" from the real total instead of restating the cap. Both queries are built from one
        `where` string; a count over a different set would overstate the ring on every search.
      - **Ban state per row**, hydrated through `usersByIds` — the existing helper for exactly this
        (ClickHouse rows carrying ids and no names). Four states, because they are not one thing:
        `active`, `banned`, `deleted`, and `gone` for an id ClickHouse has a registration for and
        Postgres has no account for. Only `active` is added to the list, and the panel says how many it
        left behind rather than quietly shrinking the number on the button.
      - **An `ipOffset` in the URL**, with Previous/Next and a header reading "501–908 of 908" — rows,
        not pages, because the question is whether the whole ring has been seen. It rides the URL like
        every other input on this page, so a search stays shareable. The ORDER carries `targetUserId` as
        a tiebreaker: bot registrations share a timestamp to the second, and without it rows either side
        of an offset are free to swap between the two requests, silently repeating and skipping.

      `getAccountsOnDomains` got the ordering fix and the same real total. It keeps EXCLUDING banned
      accounts rather than marking them, and the difference is now written down at both call sites: that
      one only ever grows a list to act on, this one is also read as a history.

      Nine tests, all mutation-checked against the emitted SQL — reverting either ordering, dropping the
      offset or the tiebreaker, deriving the total from `.length`, or dropping the status mapping each
      fail. The order is exactly the kind of defect a rendered page cannot show you: every row looks
      right, there are just the wrong 500.
      *Closes when:* a moderator runs the IP search on a ring with more than 500 registrations and
      confirms the newest accounts are the ones they can now see and act on.

## Found while in there *(08-28)*

- [x] **User Reports: the queue is one scroll area that does not fit the viewport.** *(08-28)*
      Reported as "the reports against user section has a scrollbar section that doesn't fit within the
      viewport". The left column was `xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto` around the WHOLE
      panel, so its heading, its filter bar, its fifty rows and its pager were all inside one scroll
      area: paging meant scrolling past every row to reach the control, and the filters left the screen
      while working the list. At the top of the page the `sticky` has not engaged yet either, so the
      bottom of that area sits below the fold until you scroll.

      🔴 **The first attempt did not fix it, and only measuring in a browser showed that.** Making the
      column `h-[calc(100vh-2rem)]` got the height right and ignored the OFFSET: measured at 1920×1080,
      the column started at y=136 (below the app header and the page header) and so ended at 1184 —
      104px past the fold, taking the pager (1143–1163) with it, and forcing the page itself to 1843px.
      CSS cannot read its own distance from the top of the viewport, so no calc on that element can be
      correct while a header sits above it.

      **Fixed by moving the header out of the way, which is the root cause rather than a workaround.**
      The page header now lives in the RIGHT pane, so the two-pane row is the page root and the queue
      starts at the top of the content region — its height is simply the row, with no offset to account
      for. Measured after: the queue column runs y=92→1056 against a 1080 viewport, where it used to run
      136→1184. It also buys the queue ~90px of rows back, permanently.

      Both pages moved from `wide` to the `fullBleed` mode the layout already has, so nothing above the
      row consumes height. Only the row list scrolls; heading, filters and pager stay put. `min-h-0` is
      load-bearing at every level — a flex child refuses to shrink below its content, and one missing
      instance brings the overflow straight back.

      ⚠️ **One magic number survives and is not this bug: `h-[calc(100svh-3rem)]`.** The `3rem` is the
      layout header, and every `fullBleed` page re-derives it because `SidebarProvider` is `min-h-svh`
      — "at least a viewport, grow with content" — so nothing below it is bounded and `h-full` cannot
      work. Binding it (`h-svh`) would delete the calc from every such page, but it moves scrolling off
      the document, and SvelteKit restores WINDOW scroll on back/forward: every list page would lose its
      position. That trade is unmade, deliberately.

      **That removed the page scroll, so "Recently resolved" had nowhere to live.** Decided with the
      reporter: it becomes a second TAB on the queue column (Open / Resolved), rather than moving into
      the account pane or being dropped. It needed the same internal-scroll treatment — as a plain
      section it overflowed the pane by 39px on its own.

      **Next, not done here:** make the queue column an actual `Sidebar` — collapsible, with a real
      mobile drawer instead of the current stacking. The layout is already shaped for it now that the
      header is out of the way. Two things it has to handle: one `SidebarProvider` publishes one open
      state through context, so a second `<Sidebar>` inside the existing provider would share the nav’s
      collapsed state and needs its own nested provider; and nav (16rem) plus queue (24rem) is 640px of
      chrome, which at 1280 leaves 640px for an image grid — which is the argument FOR collapsible
      rather than against the idea.

      **Also fixed, same report: the filter bar was ragged.** `ReportQueueFilterBar` is a wrapping flex
      row built for a wide bar; in the 24rem column each label+field pair wraps to its own line, and
      "Reporter" / "From" / "To" are different widths, so the three fields started at x=351, 332 and
      317. It is a two-column grid now and they share one label track.

      **`/retool/post-reports` had byte-identical markup** and got every part of this; the two queues
      are hand-copied siblings rather than a shared layout, which is why each fix was two fixes.

      Verified in a browser rather than by typecheck, which is what this whole item is about: all four
      views (both pages × both tabs) measure `scrollHeight == innerHeight` at 1280×800, 1500×720,
      1920×1080 and 2560×1440, and the three filter fields share one x. **Done.**

      **Swept the rest of the app for the same shape; not a work item.** Eight pages measured in a
      browser: only `/admin` repeats it — the grants matrix is `max-h-[calc(100vh-14rem)]` where the
      real offset is 378px, so 154px of it hangs below the fold. **Deliberately left alone** (called on
      2026-08-28); it is recorded here so the next person does not re-derive it, not as work anybody
      owes. Everything else is clean. Two near-misses: `user-lookup/[section]`’s Buzz form is
      `xl:sticky` with no height cap — harmless only while it stays shorter than the viewport — and
      `/admin` has a second `max-h-[60vh]` panel whose content never reaches the cap.

      ⚠️ Grepping for `overflow` alone over-reports: setting one axis to `auto` computes the other to
      `auto` too, so every `overflow-x-auto` table wrapper looks like a vertical scroll container. With
      no height constraint they just grow and the page scrolls, which is not the bug.


- [x] **Account History states three caps as facts, and one of them bites 13,626 accounts.** *(08-28)*
      Found by sweeping for the shape behind the Bulk Ban report above, and it is the same defect on a
      more expensive screen — `AccountHistory.svelte` is rendered by both `PostPanel` and `SuspectPanel`,
      which is where the next strike is decided. Every count comes off `.length` over a capped query:

      - `Moderation activity ({activityRows.length + retoolActivity.length})` — `getModActivity` is
        capped at 100 and `getRetoolActivity` at 100. **This one truncates today.** Measured on
        production 2026-08-28: **13,626** accounts have more than 100 `ModActivity` rows reachable
        through their images alone. Those all render a number that is the cap.
      - `Strikes ({strikes.length})` — `getLiveStrikes` defaults to 50. **Does not truncate today**: no
        account has more than 50 strike rows. Worth fixing with the others rather than on its own.
      - `Account reports ({reportsOnUser.length}, human-filed)` — capped at 20, unmeasured.

      **Worse than a wrong number, and this is the part that decided the fix.** The activity list has a
      "Show all (N more)" control, and `activityHidden` is computed from the already-truncated arrays.
      So on an account with 341 enforcement actions the header said 200, the control offered 150 more,
      and clicking it flipped to "Show fewer" with nothing hidden. The panel did not merely under-report
      — it confirmed completeness, on the screen where a moderator decides whether this account has been
      enforced against before.

      **Fixed 2026-08-28.** Every source is asked for ONE ROW MORE than the panel shows, and
      `account-history.ts` drops the extra and returns a `truncated` flag per list. Counts render as
      "200+" when cut and plainly when not, the expand control says "150+ more", and an expanded but
      truncated list carries "Older activity beyond this is not shown." One flag covers the merged
      activity list, since the panel counts its three sources as one number and a cap on any of them
      makes that number wrong.

      **A `count()` per source was considered and rejected.** It would give "200 of 341" instead of
      "200+", at four more queries — one of them the `ReToolActions` seq scan — on a panel that
      re-renders on every queue row click, to sharpen a number nobody acts on past "there is more".
      `truncated` is also the spelling `BulkBatch` already uses, so this follows an existing convention
      rather than adding a sixth.

      Four tests, mutation-checked: dropping the `+ 1`, leaking the extra row, and the `>=` boundary that
      would report an account with exactly 50 strikes as "50+" each fail.
      *Closes when:* a moderator opens an account with a long enforcement history and the panel says how
      much it is not showing — confirmed on the queue, since none of this is visible from the code.

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

- [x] **Contest bans list caps at 20, and a new ban appears to do nothing.** Both symptoms are one bug.
      `/moderator/contests/bans` calls `user.getAll({ contestBanned: true })`, whose input extends
      `getAllQuerySchema` → `paginationSchema`, where `limit` is `.default(20)`. The page never passes a
      limit, so the query lands `LIMIT 20` and there is no total in the response to say what was cut.

      The "it didn't take" half follows from the same query: `getUsers` emits **no `ORDER BY`** unless a
      search term is present, so which twenty rows come back is whatever Postgres returns. A ban that
      succeeded lands somewhere arbitrary in a set larger than the window. The write is fine — the list
      cannot show it.

      Fix belongs in the port, not in a bigger `limit`: its own load, ordered by `bannedAt` desc, paged
      with a count, searchable, and with unban and edit-reason on the row.

      **Both symptoms fixed 2026-08-31, ahead of that port.** The ordering half is the one that
      mattered and it cost one clause: `getUsers` now orders the contest path by
      `meta #>> '{contestBanDetails,bannedAt}' DESC`, so a ban that just succeeded is the first row
      instead of landing anywhere in an unordered window. `bannedAt` is an ISO-8601 UTC string, so the
      text sort is chronological, and all 39 production rows carry a well-formed one.

      The page also asks for `limit: 200` — the schema ceiling, **not** paging. At today's 39 rows the
      list is complete; past 200 it silently truncates again, which is the port's job to fix properly.

      ⚠️ The query input is now a shared `CONTEST_BANNED_QUERY` const used by the query AND both
      `invalidate` calls. Changing the input without changing them would leave the list not refreshing
      after a ban — the exact symptom being fixed here, reintroduced by the fix.

      ⚠️ **Fixed 2026-08-31, and it was reachable rather than latent.** In `getUsers` the `ORDER BY`
      was spliced into the middle of the `WHERE` clause, above the `contestBanned` predicate, so a
      caller passing both emitted `... ORDER BY ... AND ...` — rejected by Postgres with 42601 before
      it ran. `user.getAll` routes to `getUsers` whenever a moderator sets `contestBanned`, and `query`
      is on the same input schema, so any moderator searching a contest-ban list would have hit it. The
      clause now sits after every predicate.

      Pinned by `get-users-clause-order.sql.service.test.ts`, which reads the emitted SQL and asserts
      the ORDER of the clauses rather than their presence — both branches are optional, so the wrong
      shape typechecks and every current caller passes one or the other. Mutation-checked: putting the
      clause back on the `!= -1` line fails it. This does NOT close the item above; the list still
      needs its own load, ordering and paging.

- [x] **User Lookup shows no contest-ban flag.** `getUserLookup` already selects
      `u.meta #>> '{banDetails,reasonCode}'` and `{banDetails,detailsInternal}` off the same row, so
      adding `{contestBanDetails,bannedAt}` costs nothing extra. Render it as a badge in the pinned
      account-state column beside banned / muted — the column that exists precisely so a flag is not
      buried behind a long username.

      **Done 2026-08-31.** One more `#>>` beside the two already there, and a `contest banned` badge
      OUTSIDE the `bannedAt` block — a contest ban leaves the account otherwise in good standing, so
      nesting it under the site ban would hide it on exactly the accounts that have one. Checked
      against production: 39 accounts are contest-banned and every one sampled has `bannedAt` null,
      which is why this was invisible rather than merely unlabelled.

      ⚠️ **Not seen rendered.** Verified by typecheck and by confirming the JSON path returns real
      timestamps in production; the local login could not be re-established to look at the page. Three
      lines of markup mirroring the two badges above it, but that is an argument about risk, not
      evidence.

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

**Not tracked here: who holds which grant.** The grant system is built — permissions are declared in
`$lib/permissions.ts` and ticked per role on `/admin`. A moderator who cannot reach a page or run an
action is a provisioning question for Seb, not a defect and not engineering work, so those reports do
not become boxes on this list. [`action-grants-review.md`](action-grants-review.md) remains as the
reference for what needs ticking, including Post Reports.

## P1 — reported defects

- [ ] **Comment highlighting does not work on article comments** *(08-19)*. Read end to end and not
      reproduced from the code; needs a live repro with the URL in hand.
- [ ] **`reportedUser` renders greyed out on reports** *(08-18)*. Was filed as downstream of a missing
      grant; with grant provisioning off this list that explanation is no longer an answer, so it needs
      a real look or a repro. (The staff-role lookup report that sat above this was provisioning and is
      gone — see the note under P0.)
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
