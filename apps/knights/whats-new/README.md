# What's new

Each `YYYY-MM-DD-slug.md` file here is one entry in the game's "What's new" dialog. A player sees the entries newer than
the last one they saw, so a later entry needs a later name: the files sort by name. This README is not an entry.

```md
---
title: One short sentence, shown in bold.
minRank: Knight          # optional: Acolyte, Knight, Templar, Paladin or Inquisitor; omitted means everyone
link: /settings          # optional: a path inside the game
linkText: Open Settings  # required with link
---
One or two plain sentences: what changed and where to find it. No HTML or Markdown formatting.
```

Write an entry in the PR that ships a change players will notice, once it is on for them. A `minRank` entry is not marked
new for a player who reaches that rank later (the marker is one newest id), though it is in their list from then on. `whats-new.test.ts` checks
every file.
