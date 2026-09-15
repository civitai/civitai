# Compressed vs Lossless

Implementation plan for ClickUp milestone [868m4c36k](https://app.clickup.com/t/868m4c36k).

Follows PR #4752 (hi-DPI variants on post detail / model showcase) and the 2026-09-14 call
with Justin, Koen and Manuel.

---

## 0. The blocking question, answered

The milestone says nobody may be defaulted to compressed until this is settled:

> Does the optimized route strip prompt metadata?

**It does not. `optimized` has no effect on metadata at all. Resizing does — and only for one
of the two carriers.**

Measured 2026-09-15 against the live CDN (`image.civitai.com`), 8 prod images, 3 variants each:

| Image | Carrier in the stored original | `original=true` | `width=800` (JPEG) | `width=800,optimized=true` (WebP) |
|---|---|---|---|---|
| `51461947…` | EXIF `UserComment` | prompt present | **prompt present** | **prompt present** |
| `6e43dfb9…` | EXIF `UserComment` | prompt present | **prompt present** | **prompt present** |
| `29b5b39a…` | EXIF `UserComment` | prompt present | **prompt present** | **prompt present** |
| `13e4b4e5…` | EXIF `UserComment` | prompt present | **prompt present** | **prompt present** |
| `833d6872…` | EXIF `UserComment` | prompt present | **prompt present** | **prompt present** |
| `20b71b0a…` | EXIF `UserComment` (ComfyUI JSON) | present | **present** | **present** |
| `f7fc1616…` | PNG `tEXt/parameters` | present | **lost** | **lost** |
| `7f5b16b1…` | none | — | — | — |

Two conclusions:

1. **Optimized ≡ unoptimized on metadata.** At the same width, the JPEG and the WebP carry a
   byte-for-byte equivalent EXIF block (1442-byte `UserComment` on `51461947…`, 4534 on the
   `artspiral` pair, 8556 on `13e4b4e5…`). The format choice is not a metadata choice. Justin
   and Koen were right; the earlier answer Manuel got was wrong.
2. **The one real loss is caused by the resize, not the format.** An image whose prompt lives in
   a PNG `tEXt` chunk loses it the moment the cacher re-encodes, in *both* formats. That loss
   exists today, for everyone, on every card feed — it is not something defaulting to compressed
   introduces. `metadata=keep` does not recover it (verified: same 145,080-byte JPEG with and
   without the param).
3. **Downloads are unaffected.** `optimized` is ignored when `original=true` — verified, both
   URLs return the identical 2,545,486-byte PNG. So "downloads always get the original" already
   holds structurally and needs no new code.

⇒ **Defaulting everyone to compressed is safe on the metadata axis.** The closing condition's
open question is answered; this section is the written answer to put on the ticket.

### Side finding: today's default is often *worse* than the original

The unoptimized resize is a q90 JPEG re-encode. On 3 of the 8 images, `width=800` came back
**larger than the whole original file**:

| Image | `original=true` | `width=800` | `width=800,optimized=true` |
|---|---|---|---|
| `6e43dfb9…` | 353,548 | **412,463** | 164,586 |
| `13e4b4e5…` | 181,722 | **208,014** | 85,806 |
| `833d6872…` | 257,940 | **319,355** | 112,466 |

So "Unoptimized" is not a quality win on those surfaces — it is a bigger file of the same or
worse image. This matters for the copy (§3.1).

---

## 1. What is actually broken today

`resolveOptimized` (`src/client-utils/edge-url.ts:81`) is the single place the preference is read:

```ts
return !!(optimized || shouldForceOptimized(width) || hiDpi || imageFormat === 'optimized');
```

Every term is a **force-on**. There is no term that can force *off*. Consequences:

- **The preference can only ever turn compression ON.** A user who picks "Unoptimized" and one who
  leaves it unset get identical URLs on every surface where another term fires.
- `shouldForceOptimized` is `width <= 450` (`edge-url.ts:64,67`). That covers essentially every
  card feed — 87 call sites in `src/components` request a width of 450 or below. **This is the
  user report.** Someone who set "Unoptimized" sees WebP across `/images`, `/videos`, model
  galleries, search results, avatars, the sidebar, everywhere.
- `hiDpi` (added in #4752) forces it on post detail and the model showcase too.
- What is left honouring the preference is the narrow middle: widths 451–1800 that don't opt into
  `hiDpi`. That is the inconsistency users are reporting as a bug.

Provenance, so nobody asks the wrong person: the `<=450` rule is **Briant Diehl, `3b672008b4`,
2025-07-31** — two lines, message `smaller images should be rendered as webp`, no body, and no
PR (it went in on a branch), so no rationale is recorded anywhere. Zach's `a5ecf6b8e8`
(2026-07-27) only *extracted* it into `OPTIMIZED_WIDTH_THRESHOLD` + `shouldForceOptimized` so the
announcement health monitor could reproduce the URL; that monitor constraint is the part he owns.

Secondary defects in the same area:

- The `resolveOptimized` doc comment states the prompt is "absent from \[a resized variant] in
  either format". §0 shows that is false for the EXIF carrier, which is 6 of 8 sampled images.
  It must be corrected — a wrong comment on a load-bearing helper is worse than none.
- The settings label says **"Optimized (avif, webp)"**. We do not serve AVIF. Verified:
  `width=800,format=avif` returns `image/jpeg`, and `optimized=true` returns `image/webp`. Koen
  confirmed on the call that the cacher *can* do AVIF but no endpoint exposes it.

---

## 2. Who this moves — measured, not guessed

Prod, `User` where `deletedAt IS NULL`, 2026-09-15. Paid member = an `active`/`trialing`
`CustomerSubscription` on a `Product` whose `metadata.tier` is not `free`:

| `filePreferences.imageFormat` | Paid member | Users | Share |
|---|---|---|---|
| *(unset)* | no | 11,740,044 | 99.25% |
| `optimized` | no | 67,187 | 0.57% |
| **`metadata`** | **no** | **12,717** | **0.108%** |
| *(unset)* | yes | 5,176 | 0.044% |
| `optimized` | yes | 331 | 0.003% |
| `metadata` | yes | 137 | 0.001% |

**This answers Justin's open "can we switch existing users, or only new ones?" — we can switch
everyone, with zero writes.** 99.3% of accounts have never touched the setting, so changing the
*fallback* for an unset value moves them. No backfill, no migration, fully reversible by
reverting the constant.

The only cohort that loses something is the **12,717 non-member accounts that explicitly chose
unoptimized**. The 137 paid members who chose it keep it.

---

## 3. Target behaviour

From the call:

- Rename the setting to **Media Quality**; the options become **Compressed** and **Lossless**.
- Default is **Compressed**, for everyone.
- **Lossless is selectable only by paid members.** Lapsed membership silently reads as Compressed.
- Applies to **on-site browsing only**. The download button always gets the original.
- Videos are always compressed (MP4/WebM transcode) — the setting only changes images.
- Client-side only. Justin explicitly accepted that a userscript can bypass it: *"it's a pseudo
  benefit, I guess."* No server enforcement in scope.

### 3.1 Decisions still needed

**(a) Is "Lossless" honest enough?** On every browsing surface the "lossless" path is a *resized,
re-encoded q90 JPEG*, and §0 shows it is frequently larger than the original for no visible gain.
Only the download (`original=true`) is genuinely lossless.
*Recommendation:* keep Justin's **Compressed / Lossless** labels — they are the sell, and the
accuracy problem is in the description, not the name. Put the precision in the helper text:
"Lossless — images are served without additional compression. Downloads always give you the
original file, on any plan." Do not claim bit-exactness in the UI.

**(b) Does a member on Lossless keep it at 2x (`hiDpi`)?** A 1600px unoptimized JPEG is ~1 MB
against ~305 kB WebP.
*Recommendation:* **yes, honour it.** Manuel's framing on the call — *"anyone who's paying, we can
provide the bandwidth"* — is the whole product argument, and 5,644 paid members is a bounded
bill. Forcing compression on the people who paid to avoid it reproduces the bug we are fixing.

**(c) Does a member on Lossless keep it in card feeds (≤450)?** ~117 kB JPEG against ~48 kB WebP,
on an infinitely scrolling surface.
*Recommendation:* **yes.** Same argument, and "we ignore your choice in feeds" is literally the
report that opened this. If the bill turns out to bite, the flag (§5) scopes it back.

**(d) AVIF.** Out of scope — tracked separately as 868m47x1g / 868m47y1r. But the **"(avif, webp)"
label must go** in this PR, because it is currently false.

---

## 4. Work breakdown

**One PR**, `feat/media-quality-compressed-lossless`, two commits. The resolver change, the default
flip and the membership gate cannot be separated — deleting the `<=450` force is already visible to
the 12,717 non-member accounts on explicit `metadata` (§2) — and the rename is meaningless without
the gate, so the whole thing ships behind one flag.

Where the flag is read is not a detail. `useEdgeUrl` runs on every image, so anything it imports
lands in nearly every suite's import graph, and the flag provider cannot go there: a wholesale
`vi.mock` of `~/providers/FeatureFlagsProvider` naming only `useFeatureFlags` — 52 files, the
repo's prevailing style — leaves the second hook unbound, and the importing file then fails to
**collect**, reporting zero tests rather than a failure. So the quality is resolved once in
`MediaQualityProvider`, and the context it writes lives in its own module importing nothing but
React and a type. (`src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts`
documents the same incident from the other direction.)

### Commit 1 — Resolver, default and gate (flag-gated)

- `src/client-utils/edge-url.ts`
  - Replace `resolveOptimized`'s all-force-on shape (`edge-url.ts:81`) with an explicit
    precedence:
    1. an explicit `optimized` prop still wins (chrome: stickers, avatars, shop tiles, OG images,
       the announcement banner — all already pass `optimized: true` and should stay compressed);
    2. `original: true` -> never compressed (already true; keep it that way);
    3. otherwise the **user's media-quality choice decides**, with Compressed as the fallback.
  - `shouldForceOptimized` / `OPTIMIZED_WIDTH_THRESHOLD` stop being a *force* and become dead
    weight. `getAnnouncementImageUrl` (`src/components/Announcements/announcement-image.ts:48`)
    is the only non-test reader; switch it to an explicit `optimized: true` and delete the pair.
    🔴 That URL is probed by the `announcement-media-check` job — renderer and monitor must move
    in the **same commit**, or the monitor probes a variant nobody loads and alerts on a healthy
    banner.
  - Fix the false metadata claim in the `resolveOptimized` comment; cite §0.
- `src/client-utils/cf-images-utils.ts:54` — `useEdgeUrl` passes a resolved quality + eligibility
  instead of the raw `imageFormat` string.
- New hook (`useMediaQuality`, beside `useCurrentUser`) resolving eligibility, effective quality,
  and whether the user is being *held* at Compressed by a lapsed membership.
  🔴 Gate on **`isPaidMember`**, not `isMember`. `CivitaiSessionProvider.tsx:63` defines
  `isMember = user.tier != null`, which is **true for tier `'free'`**. The correct predicate is
  `!!tier && tier !== 'free'` (`CivitaiSessionProvider.tsx:64`), matching what the feature-flag
  service already means by `'member'` (`feature-flags.service.ts:900`).
- Flip the unset fallback from `'metadata'` to `'optimized'`. No backfill (§2).
- A non-member whose stored value is `'metadata'` renders as Compressed. Do **not** overwrite
  their row — if they subscribe, their old choice comes back.
- Keep the persisted values `'optimized' | 'metadata'` on disk. Renaming the stored enum buys
  nothing and costs a migration across 80k rows plus `apps/auth`'s session shaping
  (`apps/auth/src/lib/server/auth/session-shape.ts:178`). Rename at the UI boundary only.

**Tests**, in `src/client-utils/__tests__/cf-images-utils.test.ts` (19 tests today):

- Non-member with `imageFormat: 'metadata'` gets `optimized=true` at 800px **and** at 450px.
- **Paid member** with `'metadata'` gets **no** `optimized` param at either width — the assertion
  the reported bug fails.
- Unset + non-member -> compressed (the default flip).
- Explicit `optimized: true` still wins for a lossless member (chrome surfaces).
- `original: true` never emits `optimized`, for anybody.
- `hiDpi` + lossless member behaves per decision 3.1(b).
- Flag off -> today's URLs, byte for byte.

Check the revert, per CLAUDE.md: each must fail with a readable assertion when the old resolver is
put back, not pass quietly.

Run: `pnpm exec vitest run --project 'unit*' src/client-utils/__tests__/cf-images-utils.test.ts`

### Commit 2 — Copy and UI

- `src/components/Account/SettingsCard.tsx:78` and `:410` (`ImageFormatSelect`, also used by
  `PreferencesPane.tsx:57`) — two copies of the same select; keep them in step.
  - "Preferred Format" -> **"Media Quality"**
  - "Optimized (avif, webp)" -> **"Compressed"**
  - "Unoptimized (jpeg, png)" -> **"Lossless"**
- Lossless disabled for non-members, with an upsell affordance to `/pricing`.
- Helper text covering the three things people will otherwise file tickets about: it affects
  on-site browsing only; downloads always give the original on any plan; videos are always
  streamed compressed.

The select follows the same flag, so the labels and the URLs can never disagree: gating the copy
but not the URLs would put "Compressed" in front of a user still being served the uncompressed
variant at every width above 450.

---

## 5. Rollout

Flag `mediaQualityDefault` / `media-quality-default`, **`availability: []`**.

Note this is the *opposite* shape from `hiDpiPreviews`, and deliberately: `['public']` means
fail-open, which for this flag would mean an unannounced global default change the first time
Flipt is unreachable. Dark-by-default is the safe fallback here because the pre-change behaviour
is the status quo, not a regression.

Flipt is GitOps-only (v2 OSS returns 501 on writes) — the flag has to be created by a push to
flipt-state, and a 100% threshold rollout overrides `enabled: false`, so read `rollouts[]` and
not the `Status:` line when checking it.

1. Preview environment — eyeball quality on post detail, the showcase carousel and a card feed
   at DPR 1 and DPR 2.
2. 10% → watch Cloudflare egress and image-cacher origin fetches. **This is the real risk**:
   §2 says ~99% of accounts have never requested an optimized variant, so a large share of the
   compressed derivations have never been generated and the first request for each is a cold
   origin miss. Ask Koen for the cacher's current hit rate on `optimized=true` before raising.
3. 25% → 50% → 100%, waiting for the cache to warm between steps.
4. Lossless-for-members ships un-flagged with PR 2/3 — it only *widens* what 5,644 accounts can
   ask for, and it is the fix for the reported bug, so gating it delays the thing users complained
   about.

**Rollback** is the flag alone. No data is written, so nothing needs undoing.

---

## 6. The 900 rung — blocked on civitai-image-cacher

Enabling `hiDpi` on card feeds needs a 900 rung, because 450 x 2 = 900 and the ladder's next value
is 1200. **The cacher does not have one, and adding 900 to `COMMON_IMAGE_WIDTHS` on this side alone
makes things worse, not neutral.**

Measured 2026-09-15 on the live CDN, same image, decoded pixel dimensions read from the container:

| Requested | Content-Type | Bytes | Actual pixels |
|---|---|---|---|
| `width=450,optimized=true` | webp | 48,144 | 450 x 658 |
| `width=800,optimized=true` | webp | 153,776 | 800 x 1169 |
| **`width=900,optimized=true`** | webp | **239,932** | **1200 x 1754** |
| `width=1000,optimized=true` | webp | 239,932 | 1200 x 1754 |
| `width=1200,optimized=true` | webp | 239,932 | 1200 x 1754 |

`width=900` is byte-identical to `width=1200`: the cacher snaps server-side to its own next rung.
So a client-side 900 would emit a *new URL* that returns the *same 1200px object* — a second cache
entry for identical bytes, and 5x the bytes of the 450 variant for a box that renders ~318 CSS px.

**The ask is one line in civitai-image-cacher's `ImageCacherOptions.CommonSizes` (Koen): add 900.**
Confirm it landed by re-running the table above and checking that `width=900` reports 900 actual
pixels rather than 1200. Once it does, this side is two changes:

1. add `900` to `COMMON_IMAGE_WIDTHS` in `src/client-utils/edge-url.ts`;
2. pass `hiDpi` on the card components (`ImagesCard`, `ImageCard`, the model-page gallery).

Until then, card feeds stay 1x on purpose.

---

## 7. Out of scope

- **AVIF** — 868m47x1g / 868m47y1r. Koen: the cacher supports it, no endpoint exposes it, "that's
  just a one liner". Justin's caveat stands: the honest case is page snappiness, not our bandwidth
  bill, since we still serve unoptimized to some people and it all goes through Cloudflare.
- **Crop behaviour** on `ImagePreview` — the other half of 868m36wyd, untouched by #4752.
- **The video download button doing nothing**, noticed live on the call at [9:49]. Unrelated bug,
  needs its own ticket.
