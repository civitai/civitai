# Timed polls on creator profiles — proposal

> **Status:** Proposed, not staffed. Waiting on a build / won't-do decision. If it's approved, a
> design/build ticket replaces this one and this file becomes the plan of record. If it's declined,
> mark this file **Declined**, record the reason, and keep it so the request isn't re-filed blind.

## The request

Creators want to ask their audience a question on their profile, for example "which face should I
train next as a character?" The request came out of a creator feedback session on 2026-09-24, and a
second creator backed it.

- A poll is **timed**: it opens, runs for a set period, then closes and shows its result.
- **Single or multiple choice.**
- **Optional image per option.** Creators asking about a character or a style want to show the
  candidate options as images.
- It appears in a **profile section** or the **profile sidebar**.

Today the only way to run a poll is a StrawPoll embed inside an article (`InsertStrawPollControl`,
`src/libs/tiptap/extensions/StrawPoll.ts`). The vote happens off-site, the result isn't on the
profile, and the article has to be found before anyone can vote.

## Options

|     | Option                                                                   | Cost                                           | What it gives creators                                |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------- |
| A   | Won't do: keep the StrawPoll-in-article route                            | none                                           | nothing new                                           |
| B   | Native poll, **profile section only** (the MVP below)                    | 3 new tables, 1 profile section, 1 tRPC router | the full request apart from sidebar placement         |
| C   | B plus a **sidebar card** and a **"poll closed" notification** to voters | B + 1 component + 1 notification type          | the whole request, plus a reason for voters to return |

**Recommendation: B, with C's sidebar card as a fast follow if B gets used.** The profile-section
registry makes B mostly additive (see [Where it plugs in](#where-it-plugs-in)). The sidebar is already
dense on mobile, so it's worth confirming demand before adding to it.

Pasting a StrawPoll link into the profile bio isn't an option: the bio is plain text and doesn't
render embeds.

## MVP scope (option B)

### Creator side

- One **open** poll per creator at a time. Closed polls stay visible until the creator deletes them
  or starts a new poll. The section shows the newest one.
- A question of up to 200 characters, and **2–10 options**, each with a label of up to 80 characters
  and an optional image.
- **Choice mode:** single, or multiple with a maximum number of selections (default: no limit).
- **Duration:** 1 hour to 30 days, chosen as an end time when the poll is created. The creator can
  **close it early**, but can't extend it or edit its options once a vote is cast. This prevents an
  option from changing meaning after people voted for it.
- The poll is created and managed from the profile's **Edit profile** flow, next to the existing
  section toggles (`ProfileSectionsSettingsInput`), with a new `poll` section key.

### Voter side

- Only signed-in users can vote, and each gets one ballot per poll. Users the creator has blocked,
  and muted or banned users, can't vote. The block check reuses `throwIfBlockedByOwners` in
  `src/server/services/block-check.service.ts`, the guard comments and reactions use.
- **A vote is final.** This keeps the counts simple and makes a closing surge harder to game. If the
  decision is to let voters change their vote before close, that's a small extension because it's a
  delete-and-insert on the same ballot.
- **Results:** a voter sees live percentages after voting. Everyone sees them after the poll closes.
  The creator always sees live counts.
- Vote counts only. The UI never shows who voted for what.

### Out of scope for the MVP

Buzz-weighted or paid votes, member-only polls, ranked choice, polls in articles/posts/models,
embedding a poll elsewhere, and exporting voter lists.

## Data model

Three new tables. Nothing on the profile tables changes except the new `poll` value inside the
existing `profileSectionsSettings` JSON, which the schema already accepts once the key is added to
`ProfileSectionTypeDef`.

```prisma
model Poll {
  id            Int          @id @default(autoincrement())
  userId        Int
  question      String
  multiple      Boolean      @default(false)
  maxSelections Int?
  startsAt      DateTime     @default(now())
  endsAt        DateTime
  closedAt      DateTime?    // set on early close; otherwise endsAt is the close
  nsfwLevel     Int          @default(0) // max of the option images' levels
  createdAt     DateTime     @default(now())
  options       PollOption[]
  votes         PollVote[]

  @@index([userId, createdAt])
}

model PollOption {
  id      Int     @id @default(autoincrement())
  pollId  Int
  index   Int
  label   String
  imageId Int?    // Image row, so the normal ingestion + rating path applies
  votes   PollVote[]

  @@unique([pollId, index])
  @@index([imageId]) // ON DELETE SET NULL trigger support
}

model PollVote {
  pollId    Int
  optionId  Int
  userId    Int
  createdAt DateTime @default(now())

  @@id([pollId, optionId, userId])
  @@index([pollId, userId])
}
```

- **Counts** are a `GROUP BY optionId` on `PollVote` for one poll. A profile shows at most one poll,
  so this is a single indexed aggregate per profile view. Cache it in Redis with a short TTL if
  profile traffic calls for it. No metrics pipeline is needed.
- **Max selections** is enforced in the vote mutation, in the same transaction that inserts the
  ballot rows. That transaction also checks that the poll is open and that the user hasn't voted
  yet.
- Deleting a user cascades to their polls and ballots.
- The migration is new tables only, with no backfill. It's applied by hand like every migration in
  this repo.

## Moderation and domain gating

- **Option images** are uploaded as `Image` rows through the existing upload and ingestion path, so
  scanning and rating apply unchanged. An image that's blocked or still pending ingestion isn't
  shown.
- **Poll `nsfwLevel`** is the maximum of its option images' levels, recomputed when ingestion
  finishes. A poll is hidden where the viewer's browsing level or the domain wouldn't show its
  images, the same way the profile's SFW overrides keep `.com` clean.
- **Text:** the question and option labels get a text-scan profile under
  `src/server/services/text-scan/profiles/`, registered like the existing `user-profile` profile.
- **Reporting:** add `poll` to `ReportEntity` so a poll can be reported from its card. Moderators get
  close and delete actions on the existing report-handling surface.

## Where it plugs in

| Piece                    | Location                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section key, default off | `ProfileSectionTypeDef` in `src/server/schema/user-profile.schema.ts`; `defaultProfileSectionStatus`, `ProfileSectionComponent`, `profileSectionLabels` in `src/components/Profile/profile.utils.ts` |
| Section component        | `src/components/Profile/Sections/PollSection.tsx`, built on `ProfileSection`                                                                                                                         |
| Create/manage UI         | `src/components/Profile/ProfileSectionsSettingsInput.tsx` (or a modal opened from it)                                                                                                                |
| Sidebar card (option C)  | `src/components/Profile/ProfileSidebar.tsx`                                                                                                                                                          |
| API                      | new `poll` tRPC router and service: `getActiveForUser`, `create`, `close`, `delete`, `vote`, `getResults`                                                                                            |
| Text moderation          | new `poll.profile.ts` text-scan profile                                                                                                                                                              |
| Reporting                | `ReportEntity` in `src/shared/utils/report-helpers`                                                                                                                                                  |
| Rollout                  | a feature flag on the section and router while it's tested                                                                                                                                           |

The section is **off by default**, matching `shop` and `onSale`. A creator who never runs a poll
doesn't get an empty section.

## Decisions needed

1. **Build it at all?** Choose A, B or C.
2. **Can voters change their vote before close?** The proposal says no.
3. **Live results:** the proposal shows results to a voter only after they vote. The alternative is
   to hide everything until the poll closes, which avoids bandwagon votes but makes the poll feel
   inert while it runs.
4. **Who can create a poll?** The proposal lets any creator create one. The alternative is to limit
   it to Creator Program members during rollout to keep moderation load small.
