---
name: feature-walkthrough
description: Capture a finished feature as live screenshots and assemble them into a shareable walkthrough page for review. Use when someone needs to see a feature working but a live demo isn't possible — a reviewer in another timezone, a stakeholder who wants to look before a rollout, a PR whose value doesn't survive a diff. Produces a published artifact, not a slide deck.
---

# Feature walkthrough

Drive a feature through every state that matters, screenshot each one from the real app, and
assemble them into one page a reviewer can read start to finish. The output is a published
Artifact — a private URL the author can share.

This is a **demo substitute**, not a test report. If the question is "does it work", run the
tests. If the question is "is this the right product", this is the shape that answers it, because
the reviewer sees the screens rather than a description of them.

## ⚠️ Dev database only — never production

Every step below **writes**: seeding a scenario needs contributor rows, invites, lapsed flags and
half-finished states that no real account should ever be put into, and the restore at the end
deletes rows. Doing that against production would corrupt real users' data.

Before the first write:

1. Confirm the app you are driving points at a **dev database**, and that the query tool you seed
   with points at the same one. Check the connection your `.env` actually resolves to — do not
   trust a log line that says which database it is.
2. Re-check after any long gap. The `postgres-query` skill's target can be re-pointed between
   sessions, and a "dev" fingerprint taken an hour ago is not evidence about the query you are
   about to run.
3. Never pass a writable flag to a production target. If you cannot tell which target you have,
   stop and ask.

Also assume the screenshots are **going to be shared**. Anything on screen — usernames, avatars,
collection names, item thumbnails — leaves with the report. Prefer dev accounts whose content is
unremarkable, and read the captures before publishing rather than after.

## Setup

Copy `.env.example` to `.env` in this directory and adjust if your ports differ. It is gitignored;
every developer supplies their own. Nothing in it is secret.

Screenshots default to a temp directory, outside the repo. If you point `SHOTS_DIR` somewhere
else, keep it outside the checkout — the captures show dev accounts and their content, and this
repo is public. `/shots/` and `**/walkthrough-shots/` are gitignored as a backstop, not as
permission to write there.

You need three things running:

- the app and, for anything behind sign-in, the auth hub — see the **`dev-server`** skill
- the **`browser-automation`** server, which gives you one session per user so you can hold
  several signed-in accounts at once
- the **`postgres-query`** skill for seeding and for verifying the restore

Signing a session in as a given user is covered by `browser-automation` and the dev-login notes in
memory; it is deliberately not restated here.

## The loop

**1. List the states before you touch anything.** Write them down. Every state a screenshot has to
prove, including the empty, blocked and refused ones — those are usually the interesting half and
the easiest to forget. Note which are one-way.

**2. Seed the scenario.** Multi-user features need states the UI cannot reach on its own (someone
already holding a role, an invite sent six days ago, a lapsed subscription). Seed those directly,
and keep a note of every row you create — that note is your restore script.

**3. Capture, in dependency order.** This is the step people redo. A pending state has to be shot
*before* it is accepted; a blocked state before the block is lifted. Get the order wrong and you
re-seed the whole scenario. Sequence the one-way transitions first, then everything reversible.

**4. Build the page.** A template with `{{shot-name.png}}` placeholders, then:

```bash
node .claude/skills/feature-walkthrough/build-report.mjs report.template.html shots/ report.html
```

**5. Publish and hand it over.** See below — the sharing step has an order to it.

**6. Restore, and verify the restore.** Delete what you seeded, put changed columns back, then
**query for the rows again** and confirm they are gone. Report anything you deliberately left
behind and why.

## Publishing, and the sharing handshake

Publish the built file with the **Artifact** tool. It is the right vehicle for this: one scrollable
page, screenshots inline, a URL that keeps working, and it updates in place.

```
Artifact(file_path: "report.html", favicon: "🤝", description: "<one line for the gallery card>")
```

Keep the **file path and favicon stable** across redeploys. Same path means the same URL, so a
reviewer who already has the link keeps seeing the current version; a changed favicon reads as a
different page to anyone who kept the tab open.

**Artifacts are private until the author shares them**, and an agent cannot share on their behalf.
That ordering catches people out, so do it deliberately:

1. Publish, and give the author the link.
2. Say plainly that it is private until they open it and use the page's share menu.
3. Only **after** they confirm it is shared, send the link onward.

Announcing the link to a reviewer before that step gives them a URL they cannot open. If you are
sending the message yourself, wait for the confirmation.

To update a walkthrough from a later session, pass the existing artifact's `url` — publishing
without it creates a second artifact rather than updating the first, and the reviewer's link goes
stale. Use `action: "list"` to find the URL if you do not have it.

## If an artifact isn't the right vehicle

It usually is, but the alternatives have real trade-offs:

| Instead | Worth it when | Costs |
| --- | --- | --- |
| **Link it from the PR** | Reviewers live there, and it outlives the chat | Screenshots can't be embedded from the CLI, so this is a link *to* the artifact, not a replacement |
| **Chat with attachments** | One person, one nudge, no sharing step — the `discord-bridge` skill uploads files directly | Images arrive as a pile with no order or captions; useless as a durable reference |
| **A tracker doc** | It has to be findable months later next to the ticket | Another surface to keep current, and image support varies |

The strongest combination is the artifact as the canonical page, **linked from the PR**, with a
short chat message pointing at it.

**Do not commit the report or its screenshots to this repo.** It is public and permanent: the
screenshots carry dev usernames, avatars and content, and the images bloat the tree. Publish them,
don't check them in.

## Writing capture scripts

Run them with:

```bash
node .claude/skills/feature-walkthrough/capture.mjs <session> script.js
```

The browser-automation server executes a chunk and **throws away its return value**, so a script
that inspects the page has no way to tell you what it saw. `capture.mjs` wraps the script, writes
its return value to `script.js.out.json` and prints it. Return whatever you want to assert on.

Scripts get `page` plus these, already defined:

| Helper | Does |
| --- | --- |
| `SHOTS` | absolute screenshot directory |
| `dismissOverlays()` | removes sticky banners and the chat widget |
| `shot(name, clip?)` | viewport screenshot, optional `{x,y,width,height}` |
| `shotOf(selector, name)` | element screenshot |
| `shotModal(name)` | shortcut for the open modal |
| `mainText(n?)` / `modalText(n?)` | text of `main` / the open modal |

**Call `dismissOverlays()` after every navigation, before clicking anything.** A sticky
announcement sits above the page and swallows clicks; Playwright retries for 30 seconds and then
fails with `subtree intercepts pointer events`, which reads like a broken selector and is not one.

Two more that cost time:

- **Assert what the screenshot is supposed to show.** Return the text alongside the shot. A
  screenshot of the wrong state looks fine until someone reads it.
- **Re-running a script does not reset the page.** The session keeps its position from the last
  chunk, so a script that assumed a starting URL will capture whatever is on screen instead —
  which is how the wrong modal ends up in a report. Navigate explicitly at the top of each script.

## Screenshot craft

- **Element shots beat viewport shots** wherever the DOM can scope it: no clip maths, and the
  framing survives a layout change. Reach for a clip only for composites the DOM does not group,
  like a sidebar plus its header.
- Set a **fixed viewport** for the whole run so shots share a scale.
- Keep them **tight**. The artifact ceiling is 16 MB with images inlined as base64, and a page of
  full-page screenshots hits it fast. `build-report.mjs` fails the build rather than letting a
  rejected publish surprise you.
- **Pair the before and after** for anything you changed. Two narrow shots side by side carry a
  permission split better than a paragraph.

## The page itself

Load the `artifact-design` skill before writing the template.

What makes these read well:

- **Lead with what the feature is** in two sentences, then the walkthrough in order. A reviewer
  should be able to stop after the first screen and still know what it does.
- **Caption every screenshot** with whose view it is. "Manager's edit form" beats "edit form" —
  half the value of a permissions walkthrough is who is looking.
- **Explain the non-obvious rule, not the mechanics.** Say why a row counts as shared; don't
  narrate that there is a sidebar.
- **Put the open questions in their own section** and make them answerable. A reviewer who can
  reply "option B" is worth more than one who has to write an essay.
- **State the deploy prerequisites** — anything that has to be done by hand before it ships.

## Writing the message that carries it

A link with no framing gets opened last. Say what it is in one line, then what you want back —
"three things I'd like your call on, last section" beats "let me know your thoughts".

If it goes out over chat, use the **`discord-bridge`** skill and read its `voice.md` first, so the
message sounds like the person sending it rather than like a release note. A walkthrough written in
memo voice under someone's own name is worse than one they wrote in a hurry. If no `voice.md`
exists, read a few of their own messages in that thread before drafting — and weight organic
messages over any an agent already sent, which otherwise trains the profile on itself.

Sending on someone's behalf is outward-facing: confirm the recipient before sending, and report
exactly who received it.
