# Ad Placements & Configuration

## Ad Providers

| Provider | Purpose | Script |
|----------|---------|--------|
| Snigel | Primary programmatic ads | `cdn.snigelweb.com/adengine/civitai.com/loader.js` |
| Civitai Ads | Fallback (ad-blocked, NSFW, no consent) | `advertising.civitai.com/api/v1/serve` |
| Kontext (Megabrain) | AI-powered contextual ads | `server.megabrain.co/sdk/js` |

## Global Ad Enable/Disable Logic

Ads are enabled when **all** of the following are true:

- Not in dev mode (`isDev === false`)
- `features.isGreen` is OFF
- `features.isBlue` is ON
- User allows ads OR is not a member
- Current URL is not in the blocked list
- Current page path does not end with `/edit`

### Blocked URLs

- `/collections/6503138`
- `/collections/7514194`
- `/collections/7514211`
- `/moderator`
- Any page ending in `/edit`

### NSFW Handling

When the browsing level is not "safe", third-party ads are replaced with Civitai's own ad system, which respects content browsing levels.

### Per-Page Conditions

| Page | Additional Conditions |
|------|----------------------|
| Image Detail | Hidden if `image.poi`, `image.minor`, or `collection.metadata.hideAds` |
| Model Version Details | Hidden if `model.nsfw` or `model.poi` |
| Masonry Grid | Only if `adsEnabled && safeBrowsingLevel && withAds` prop |

---

## Ad Units

### Active Snigel Units

Configured in `AdsProvider.tsx` via `snigelPubConf.adengine.activeAdUnits`:

```
incontent_1, outstream, side_1, side_2, side_3, top, adhesive
```

### Unit Sizes

| Unit | Mobile (0–759px) | Tablet (760–1023px) | Desktop (1024px+) |
|------|-----------------|--------------------|--------------------|
| **Top** | 320x100, 320x50, 300x250, 300x100, 300x50, 336x280 | 468x60, 728x90 | 728x90, 970x90, 970x250, 980x90 |
| **Incontent_1** | 320x100, 320x50, 300x250, 300x100, 300x50 | — | — |
| **Side_1** | — | — | 120x600, 160x600, 300x600, 300x250, 336x280 (1200px+) |
| **Side_2** | — | — | 200x200, 250x250, 300x250, 336x280 (1200px+) |
| **Side_3** | — | — | 200x200, 250x250, 300x250, 336x280 |
| **Adhesive** | 1x1, 320x50, 300x50 | 8x1, 728x90 | 8x1, 728x90, 970x90, 980x90, 970x250 |
| **Outstream** | 1x1 (video) | 1x1 (video) | 1x1 (video) |

---

## Placements by Page

### All Pages — AppLayout

| Placement | Component | Notes |
|-----------|-----------|-------|
| Sticky footer | `AdhesiveAd` | Bottom of viewport, closeable after impression |

### Home Page (`/home`)

| Placement | Component | Notes |
|-----------|-----------|-------|
| Between home blocks | `AdUnitTop` | Shown at alternating positions in the home block list |
| In-feed | `AdUnitIncontent_1` | Via `showAds` on `ImagesInfinite` |

### Model Page (`/models/[id]`)

| Placement | Component | Notes |
|-----------|-----------|-------|
| Top banner | `AdUnitTop` | In the suggested resources section |
| Sidebar | `AdUnitSide_2` | Only when `!model.nsfw && !model.poi` |

### Post Detail

| Placement | Component | Notes |
|-----------|-----------|-------|
| Left sidebar | `AdUnitSide_1` | Respects browsing level |
| Right sidebar | `AdUnitSide_2` | Respects browsing level |
| Video | `AdUnitOutstream` | Outstream video ad |

### Post Images

| Placement | Component | Notes |
|-----------|-----------|-------|
| Between images | `AdUnitTop` | After every 3rd image, max-width 760px |

### Image Detail (`/images/[id]`)

| Placement | Component | Notes |
|-----------|-----------|-------|
| Right sidebar | `AdUnitSide_2` | Hidden if POI, minor, or collection `hideAds` |
| Bottom adhesive | `AdhesiveAd` | Not closeable, preserves layout |

### Masonry Grid (Feed pages)

| Placement | Component | Notes |
|-----------|-----------|-------|
| In-feed | `AdUnitIncontent_1` | Density varies by column count (every 5–9 items) |

### Chat Portal

| Placement | Component | Notes |
|-----------|-----------|-------|
| Bottom-left overlay | `AdUnitOutstream` | Desktop only, when chat is closed |

### Feed Layout (wide screens)

| Placement | Component | Notes |
|-----------|-----------|-------|
| Outstream | `AdUnitOutstream` | Only on very wide screens (3200px+ container) |

### Image Generation Queue

| Placement | Component | Notes |
|-----------|-----------|-------|
| Between items | `KontextAd` | AI contextual ads, feature-flagged (`kontextAds`) |

---

## Civitai Ad Fallback Mapping

When third-party ads can't be served (ad blocker, NSFW, no consent), the Civitai ad system maps units:

| Snigel Unit | Civitai Placement |
|-------------|-------------------|
| `incontent_1` | `feed` |
| `side_1` | `side_sky` |
| `side_2` | `side` |
| `side_3` | `side` |
| `top` | `banner` |
| `adhesive` | `footer` |

---

## Impression Tracking

- GPT impressions fire `civitai-ad-impression` events
- Custom ads fire `civitai-custom-ad-impression` events
- Both recorded via SignalR worker: `recordAdImpression({ userId, fingerprint, adId })`

## Key Files

| File | Purpose |
|------|---------|
| `src/components/Ads/AdsProvider.tsx` | Global config, TCF consent, script loading |
| `src/components/Ads/AdUnit.tsx` | Ad unit definitions & sizes |
| `src/components/Ads/AdUnitFactory.tsx` | Render logic & Civitai fallback |
| `src/components/Ads/AdhesiveAd.tsx` | Sticky footer ad |
| `src/components/Ads/AdUnitOutstream.tsx` | Video outstream ad |
| `src/components/Ads/Kontext/KontextAd.tsx` | AI contextual ads |
| `src/components/Ads/ads.utils.ts` | Feed ad density logic |
