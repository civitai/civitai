# Creator tools backlog

Prioritized work items from creator-facing feedback on monetization, model management, and
discoverability. Each item states the problem and the desired outcome on its own — no external
context needed to pick one up.

Priority is highest first. Checked items are believed done; where a fix was never confirmed, the
verification step is left unchecked.

**A security item is fixed before this file is committed.** This repo is public and its history is
permanent, so an unfixed weakness described here is a to-do list for an attacker. Keep each item's
wording to the broken invariant and the intended fix — never the steps to exploit it — and do not
commit an update to this file that adds an unfixed one. Unchecked sub-items are allowed only where
they are a decision or a verification, not a known way in.

---

## P0 — security

- [x] **A blocked user can still write where the block guard doesn't reach.** Blocking is enforced
      on comment, reaction, and review write paths by resolving the owner of the content being
      interacted with. All coverage gaps below are closed.
  - [x] Two of the fifteen comment entity types resolved no owner and so were never blocked. Both
        now resolve one. The second turned out to have a nullable owner rather than no owner —
        system-created rows return none, user-created rows return their creator.
  - [x] Resolve the content owner for **replies** in those same threads. The thread-column
        selection used for reply resolution omitted three of the thread's owner columns, so a reply
        checked only the parent comment's author and not the owner of the content the thread hangs
        off. This was a separate path from the top-level case and needed its own fix.
  - [x] Make the owner-resolution switch exhaustive over the entity-type enum. It defaulted to "no
        owners", which reads as "allow", and a test pinned that default as intended — which is what
        produced both gaps above. Adding an entity type is now a build failure until it resolves an
        owner; the runtime fallback still yields "no owner" so an unexpected value cannot take a
        write path down.
  - [x] Enforce on comment **edit**, not only create. A comment written before a block could
        otherwise be edited into anything afterwards.
  - [x] Reactions share the owner resolver and inherited every gap above, so they are covered by
        the same fixes.
  - [x] Blocking stays one-directional for writes, by decision: the blocked user cannot write on
        the blocker's content, but the blocker can still write on theirs. Reciprocity is the other
        user's to choose by blocking back.
  - [x] The original report described reading, not writing — the write guard already covered the
        surfaces named. No further reproduction needed.

  Refused writes return 404 rather than stating the block, matching existing behaviour — an
  explicit refusal would confirm to a blocked user that they were blocked.

  **Reads are deliberately not blocked.** A blocked user reaching a comment thread by direct URL,
  or seeing content the UI would have hidden, is expected. Any public thread is readable by a
  logged-out visitor, so a read check buys nothing an incognito window doesn't defeat, at the cost
  of an owner lookup on hot read paths. The page-level hiding that exists today is a UI
  convenience, not a security control, and should not be promoted to a server-side check.

## P1 — monetization state is not visible where it matters

- [ ] **Surface access and pricing state on the model page.** On `civitai.com/models/:modelId`,
      generation cost is the only clearly displayed cost. A creator viewing their own model cannot
      tell whether it is under paid access or early access, or at what price, without opening the
      edit form. Show access type and price on the model page itself, for the owner at minimum.
- [ ] **Keep the price visible on the download action.** The price a buyer will pay should remain
      readable on the Download button rather than appearing only mid-purchase, so a creator can
      confirm at a glance that a model is priced as intended.
- [ ] **Verify paid-access sales are classified correctly in creator analytics.** Sales of
      paid-access-only models were reported appearing under Early Access in the analytics breakdown.
      The misclassification appears to have stopped for new sales but was never confirmed fixed.
  - [ ] Confirm current sales classify correctly for a model with paid access and no early access.
  - [ ] Decide whether historical rows carrying the wrong classification are corrected or left.

## P2 — cross-domain publishing and collections

- [ ] **Let a model carry a separate safe-for-work title, description, and cover image.** A model
      with any NSFW content is limited to `.red` today, which cuts it off from the larger `.com`
      audience and from Green Buzz sales. Allow creators to define SFW presentation metadata so the
      same model can be listed on `.com` while its NSFW assets stay gated. Requires a decision on
      which surfaces read the SFW variant (feeds, cards, search, event collections) before build.
- [ ] **Document the presentation guidance creators should follow in the meantime.** Until the above
      ships, creators have no stated rule on whether model names and cover images need to be SFW.
      Write down what is expected, since it determines whether their models qualify for SFW events.
- [ ] **Add a cover-image control to collections.** A collection has no way to specify which image
      represents a submitted model, so a model whose first image is rated above the collection's
      limit is rejected on presentation grounds even when it has qualifying images. This is the
      direct cause of otherwise-valid SFW event submissions being turned away.
- [ ] **Let a model present as SFW while its gallery may carry mature content.** A creator
      building on a base model whose licence restricts mature use wants to publish and promote the
      model as SFW — SFW name, SFW cover, SFW official images — without that presentation being
      contradicted by what the community later posts to its gallery. Two capabilities are missing: a
      deliberate SFW badge that states how the model is presented rather than being inferred from
      its images, and the ability to suppress mature images in the gallery of a model published
      under a licence that forbids them. The second is only needed for models carrying a provider
      badge, so scope it to those rather than building a general gallery control.
  - [ ] Answer the creator-facing question first, separately from any of the above: whether
        publishing a mature derivative of a licence-restricted base model puts the creator's own
        account at risk. It is a policy answer, it needs no code, and it is currently blocking
        creators from starting the work.

## P3 — model management friction

- [x] **Comment notifications ignore block relationships.** Notification generation did not filter
      on blocks, so a blocked pair kept being notified about each other's comment activity. Not a
      security gap — reads are deliberately open, so the notification disclosed nothing the
      recipient could not already reach — but it repeatedly pulled someone back toward a person who
      blocked them, which is the opposite of what a block is for. Every comment notification now
      drops recipients on either side of a block, in both directions.
  - [x] Extended to every other notification that names an acting user: mentions, and the
        new-model / new-model-version / new-article "from someone you follow" types. Mentions
        matter most — a mention reaches the recipient from content the blocker never touched, so no
        write guard can see it. The follow types matter because the follow predates the block, so
        the Follow row outlives it and keeps delivering.
  - [x] Reaction notifications need no filter: they are milestones ("your comment reached 5
        reactions"), aggregated with no acting user to compare against.

- [ ] **Identify the version in the model-version tooltip.** The tooltip does not include the
      version name, so a creator with many versions of one model must open each to tell them apart.
- [ ] **Persist model upload settings between models.** The publishing settings block resets on every
      new model. Remember the previous values, or support named templates, so a creator releasing
      models repeatedly does not re-enter the same configuration each time.
- [ ] **Scheduled price promotions.** Creators want to run time-boxed discounts. Spec as agreed with
      creators: schedule ahead with a start date, end date, discount percentage, and target model
      set; optional follower notification on launch; a per-month cap on promotions per creator so
      notifications cannot be used as a spam channel. Optionally, automatic percentage-based price
      decay after a model has been listed N days, with a price-drop notification.
- [ ] **Let creators filter the balance display to earned Buzz only.** The combined balance in the
      top-right makes it hard to read earnings at a glance. Offer a setting to show only the earned
      (yellow) balance.
- [ ] **Add a models-sold-today counter.** Creators track daily sales manually. A running count for
      the current day, visible without opening analytics, covers the need.
- [ ] **Add video leaderboards, and all-time leaderboards.** Video creators have no leaderboard to
      place on at all. Requested shape: a video board split SFW / mature over the trailing 30 days,
      and an equivalent split for video *model* creators — splitting further by individual model was
      judged too granular. Separately, every leaderboard today covers a trailing 30 days and there is
      no all-time board of any kind, so creators with a long back catalogue have nowhere that
      reflects it. The all-time request is independent of video and can ship on its own.

## P4 — discoverability and reach

- [ ] **A personalized "For You" feed.** Model and image content has a short discovery window, after
      which it effectively disappears regardless of quality. An algorithmic single-item feed —
      vertical, one resource at a time, in the shape of a short-video feed — gives older content
      repeated chances to surface. Prototyped by a creator as a browser script, so the interaction
      model is validated.
- [ ] **A "refreshed" bump for existing models.** Allow a creator who adds new example images to an
      existing model to bump it into recency-ordered feeds, at most once per month, without
      publishing a version update purely to game the sort.
- [ ] **Let creators message an audience segment.** Creators want to announce to people who both
      follow them and have downloaded a specific model. Articles are the only current option and
      reach the wrong set. Needs a per-creator send-rate limit.
- [ ] **Import a model file from an external host.** Accept a source URL plus an access token and
      have the platform pull the file server-side, instead of requiring a browser upload. Large
      model files over unreliable residential upstream links make uploads slow and failure-prone;
      a server-to-server transfer is faster and retryable.
- [ ] **Subscribe-to-creator tier.** Rather than paying per model, let a user subscribe to a creator
      for a recurring fee and receive a substantial discount across that creator's catalog. Would
      also give image-focused creators, who have no per-model sale to make, something to earn from.
- [ ] **Let users hide side-menu entries.** The main side navigation has grown long enough that
      creators want to hide items they never use. Either per-item visibility in settings, or a
      denser layout. Related: the color coding on those entries no longer maps to anything
      meaningful and should be re-derived or dropped.
- [ ] **Expose exact Buzz balances where precision matters.** The abbreviated display rounds to whole
      millions, so large balances cannot be read precisely. The underlying account endpoint already
      returns the exact figure.
- [ ] **Document and price heavier training via the API.** Programmatic LoRA training is already
      possible through the orchestration API, but the path is not discoverable from creator-facing
      docs, and there is no offering for larger jobs such as checkpoint training at a premium rate.
      The open practical question is where the training dataset archive is hosted so the platform
      can fetch it.

---

## Done

- [x] **Bulk model updates.** Creators can now bulk set licensing fees, early access, paid access,
      and usage control across models, and bulk remove licensing fees or paid access. Covers the
      reported pain points; rough edges remain and follow-up feedback has not yet been collected.
- [x] **Adding an event-collection model to an unrelated collection.** Saving a model that belonged
      to an event collection into a different collection failed with
      `Collection is not accepting submissions at this time` from `collection.saveItem`. Later
      confirmed working by the reporter.
  - [ ] Root cause was never established — confirm this was a fix and not a coincidental change in
        the event collection's submission window, so it cannot recur on the next event.
