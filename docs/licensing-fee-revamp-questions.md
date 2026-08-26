# Monetization revamp — decisions (all answered)

Answer inline on the `@dev:` line under each question. Context: moving to the model in
[article 33749](https://civitai.com/articles/33749), plus the 10k creator-score floor added
2026-08-20. Full plan in [licensing-fee-revamp-checklist](licensing-fee-revamp-checklist.md); each
answer here settles an item there.

---

## Blocking the build

### 1. What happens to creators already monetizing below the 10k floor?

845 creators, holding 1,477 fee-bearing versions. Grandfather their existing fees and apply the
floor only to new ones, or switch them off? Switching off is the only option that clears the
existing junk; grandfathering is the only one that doesn't take income from people who have it
today.

@dev: apply the floor only to new ones

### 2. Is the monthly allowance counted per model, or per model version?

Worth 18 creators in a 3-week sample (95 blocked vs 77). Fees and gates are both stored per-version,
but the article says "models". Suggest **model** — per-version counting charges a creator repeatedly
for one product, and re-uploading a fixed v2 shouldn't cost a slot.

@dev: per model version. Setting and then removing paid access does not return the allowance

### 3. Does clearing a fee refund the slot?

Refunding invites cycling through slots; not refunding punishes trying a price and thinking better
of it. Suggest **no refund**, slot tied to the model permanently.

@dev: no

### 4. Calendar month, or trailing 30 days with rollover?

Creators release in bursts after a training run, so a hard monthly reset penalises the real release
pattern (raised in the article comments). Rollover costs more storage and more explaining.

@dev: calendar month

---

## Blocking the policy

### 5. Is there a ceiling on the one-time paid-access unlock price, or is it genuinely uncapped?

The article's only number is the 100/image checkpoint fee. Gold's unlock-price cap is currently
unlimited, so "everyone gets the top ceiling" reads as no ceiling. It's the one price with no market
feedback bounding it — a per-generation fee is self-limiting because users route around expensive
models, an unlock price isn't. The 10k floor sets eligibility, not price.

@dev: uncapped

### 6. Is the proposal final as written?

Feedback closed 2026-08-13 and the score floor arrived after, so the article isn't the whole spec
any more. Specifically, are these two in or out:

- **Dormancy suspension** — require recent account activity to keep fees chargeable, so abandoned or
  inaccessible accounts stop collecting.
- **Allowance rollover** — see #4.

@dev: dormancy is abandoned. No allowance rollover.

---

## Confirmations

### 7. Does the ×5 video multiplier survive on the single global ceiling?

The article never mentions video. If it survives, the ceiling is 100/image and 500/video.

@dev: no

@dev (2026-08-21, on re-asking): leave it as is — the ×5 multiplier stays, so the video ceiling
remains 500/generation. **This answer supersedes the "no" above**; it was given after the consequence
was spelled out (dropping the multiplier would make a video model's ceiling identical to an image
model's, at 100).

### 8. Is the non-checkpoint fee ceiling also 100?

Gold is 100 for both today so it resolves itself, but every other tier distinguishes checkpoint from
other, so worth saying out loud.

@dev: no

@dev (2026-08-21, on re-asking): ceiling should be 100 for both. **This answer supersedes the "no"
above**; the follow-up asked what the non-checkpoint number should be, since "not 100" left it
undefined.

### 9. Two edges on the 10k floor

- Are moderators exempt? (They are for every other creator-score gate.)
- Does the floor override a granted `thirtyDayEarlyAccess` flag? That grant currently confers the
  top early-access rung _at any score_, so a granted user below 10k is the one case where "10k for
  any monetization" and the existing grant contradict each other.

@dev: Mods aren't exempt. Don't worry about 'thirtyDayEarlyAccess' flag, as I thought this was already wired up.

---

## Follow-ups — `@dev:` answers, 2026-08-21

Beyond the supersessions recorded inline on Q7 and Q8:

- @dev: **Eligibility rule** — "no new fee below the floor". Grandfathering attaches to the version,
  not the creator: an already-priced version keeps and may edit its price at any score; applying a
  price to an unpriced version needs ≥10k.
- @dev: **Per-version + free 3 + hard calendar reset** — "is correct. It encourages users who want to
  monetize to purchase subscriptions."
