# OFFSITE apps — `attach.sh` cannot reach them, `attach-offsite.py` can

*(Demoted verbatim from SKILL.md to keep the body lean. Nothing here changed.)*

`civitai app listing …` exits **4** for a `kind: offsite` app: it resolves a listing
through the app's block submission, and an offsite app is a registered URL with none.
So `attach.sh`, which drives the CLI, cannot serve them either.

🔴 **The CLI's refusal overstates the case.** It says media changes are *"only possible
in the App-store listing UI"*. Not true — the listing id is published on the public
`/api/v1/apps` route and every listing proc accepts it. Measured 2026-08-16: both
offsite listings return HTTP 200 from `getMyListingForEdit`, and ingest → set → submit
worked first time on both. Related: `civitai/cli#422`.

```bash
SK=.claude/skills/app-capture/scripts
python3 $SK/attach-offsite.py --app radio --icon icon.png --cover cover.jpg \
  --changelog "why" --confirm      # without --confirm it prints and exits 3
```

Same safety contract as `attach.sh`: dry-run by default, `--changelog` mandatory, and it
refuses outright if the app turns out to be onsite (use `attach.sh` there — it is the one
that gates against `.claude/skills/app-capture/scripts/store-bounds.json`).

🔴 **It targets the SHADOW, never the parent.** Addressing the parent is the same id-space
bug that made `reorder` 400 on every live listing (`civitai/cli#430`). And
`submitListingRevision` is **idempotent** — on an already-submitted shadow it replaces the
staged asset and returns the EXISTING publish-request id rather than opening a second review.
