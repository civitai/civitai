# Filing follow-up work

Read this before opening an issue, ticket or follow-up task.

## Closing conditions
🔴 **Never open an issue or ticket you cannot state a CLOSING CONDITION for.** Name what ends it **and** who or what checks it — either a mechanical check (a merged PR, a passing command, a metric back under threshold) **or** a named human judgement over named evidence ("X reviews the diff" — never "someone will decide"). If you can name neither, it is **not a work item**: say so in your reply, with why, instead of opening something nobody can close.

Why: a complete sweep of this org's open GitHub objects found that agent-filed **issues** survive dramatically longer than pull requests. The PRs close; the follow-up issues they spawn do not. Duplication turned out **not** to be the problem — closability was. The dominant pattern is *"merge a PR, then file follow-ups"*, and a follow-up filed at merge time is precisely the object born with no closing condition and no owner. Most such issues were also opened with no labels and no comments, so nothing downstream could triage them either.

**If you are an automated producer** — a bot, a scheduled job, or an agent that opens issues — also label what you create `agent/<producer>` and put a machine-readable marker in the body naming the producer and the closing condition, so the object can be reconciled and closed later instead of accumulating. Apply the label on **create only**; never let an update overwrite labels a human has set.

🔴 **Nothing enforces this.** There is no gate, no hook, and no CI check — it binds only the agents and people who read this file. If you are adding a new issue-creating producer, stamp it at the create site, because nothing will catch you if you don't.

## Two lists, and the line between them

Work you generate about your own work — the deferred half of a review, a duplicate you noticed, a missing
index, a test you did not write — goes in the **`Agent Follow-ups`** list, not the team list. Resolve the
id with `find-list "Agent Follow-ups"`.

**`Synced Team`** stays what a human would recognise as the team's work: anything a person asked for out
loud, and anything security-shaped or user-facing-broken, filed at its real priority. Those never go in
the follow-ups list — the line exists so the new list does not become where real bugs go to be quiet.

Two rules for anything you file:

- **File as the human whose session you are running in**, not as a bot account. Their name on it is what
  makes it findable by the person who has to decide it.
- **Name the PR or commit it fell out of.** A follow-up without that is a sentence nobody can act on six
  weeks later.

The follow-ups list is a queue to be worked down, not an archive.
