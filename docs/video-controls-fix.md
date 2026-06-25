# Video Controls Fix — Plan

ClickUp: [868k412h2 "Audio Slider Is Not Great"](https://app.clickup.com/t/868k412h2)

> **Status: historical planning doc.** The implementation has since diverged from the approach
> sketched below (e.g. `useSyncExternalStore` for fullscreen, Mantine `HoverCard` for the volume
> popover, render-phase mute sync). Treat any `file:line` references as approximate — the source of
> truth is `src/components/EdgeMedia/EdgeVideo.tsx`.

All custom video controls live in a single component: `src/components/EdgeMedia/EdgeVideo.tsx`
(+ `EdgeVideo.module.scss`). Every video render routes through it via `EdgeMedia`. No duplicate
implementations.

## Reported symptoms → root causes

| # | Symptom | Root cause (file:line) |
|---|---------|------------------------|
| 1 | Controls don't show until a couple refreshes | `showCustomControls = loaded && controls && !html5Controls` (`EdgeVideo.tsx:179`). `loaded` only flips via `onLoadedData`/`onCanPlay`, but `preload` is `'metadata'`/`'none'` (`:302`) and play is IntersectionObserver-gated. Offscreen / variable decode timing → events never fire → `loaded` stays `false`. Refresh changes cache/timing → events fire → controls appear. Race on a single media-event boolean. |
| 2 | Flickering | Render-body side-effects + non-reactive ref reads: `enableAudioControl = ref.current && hasAudio(ref.current)` reads a mutable ref *during render* (`:180`); `if (!initialMuted && loaded && ref.current) ref.current.volume = volume` writes DOM during render (`:184`); fullscreen icon reads `document.fullscreenElement` during render with no state (`:363`). Control subtree is inconsistent render-to-render → flicker. |
| 3 | Can't scrub volume slider — video element gets dragged | Container `<div draggable={!!imageId}>` (`:260`) wraps **both** the video and the controls. mousedown-drag on the range `<input>` triggers native HTML5 drag on the parent → pointer hijacked → scrub impossible. |
| 4 | Some videos have no audio control | `hasAudio()` (`:407`) runs too early — before audio is decoded (`webkitAudioDecodedByteCount === 0`, `audioTracks` empty under `preload`) and non-reactively. Real audio videos show no control. |
| 5 | "Audio slider is not great" (design) | Rotated-270° native `<input>` positioned with fragile `translate(-33%, -170%)` (`scss:59`), hover-only reveal, unstyled track. Hard to grab, jumps around. |

## Fix plan

### Phase 1 — robustness (fixes 1–4): state-driven control logic

Convert the render-time ref reads and DOM writes into proper React state updated by media events.
No reads of `ref.current` and no DOM mutation in the render body.

- **`loaded`**: in addition to `onLoadedData`/`onCanPlay`, set it from an effect that checks
  `ref.current.readyState >= 2` on mount, and also listen for `loadedmetadata`. Controls only need
  the element + metadata, not full playback. → controls render on first paint reliably (fix 1).
- **`hasAudioState`** (new state): default **hidden**, set from `hasAudio()` reactively across the
  video's own load/play events (`onLoadedMetadata`/`onLoadedData`/`onCanPlay`/`onPlaying`). Matches
  prod (no audio track → no button) but fixes prod's flaky single render-time read by re-checking as
  metadata/decoded-bytes become available, so the control reliably appears once audio is confirmed.
- **`isFullscreen`** (new state): subscribe to `document` `fullscreenchange` in an effect; drive the
  maximize/minimize icon from state, not a render-time `document.fullscreenElement` read (fix 2).
- Remove `if (!initialMuted && loaded && ref.current) ref.current.volume = volume` from render body;
  apply volume in an effect keyed on `[volume, loaded]` (fix 2).
- **Drag fix (fix 3)**: keep `draggable`/`onDragStart` for the media drag-to-canvas feature, but
  scope it so the controls don't trigger it:
  - `draggable={false}` on the `.controls` element (overrides the draggable parent for that subtree), **and**
  - `onMouseDown`/`onPointerDown`/`onDragStart` → `stopPropagation()` on the slider + controls bar.
  - Result: scrubbing the slider no longer starts a native drag.

### Phase 2 — audio slider redesign (fix 5): YouTube-style vertical popover

- Mantine **`Popover`** anchored to the mute `ActionIcon`, opened on hover **and** focus, click-to-pin.
- Content = a **vertical** volume slider using native range with **`writing-mode: vertical-lr`**
  (real vertical slider, correct pointer hit-area — no `rotate()` transform, no fragile translate).
  Style the track/thumb to match the dark control theme.
- **Fullscreen gotcha**: the popover must render **inside `containerRef`**, not portal to `<body>`.
  In fullscreen the document's fullscreen element is the container, so a body-portalled popover is
  invisible. Use `withinPortal={false}` (or `portalProps={{ target: containerRef.current }}`).
- Keep mute icon as the toggle (click = mute/unmute); slider sets volume and syncs muted state
  (volume 0 ⇄ muted), preserving the existing `global-volume` localStorage behavior.
- Apply the same `stopPropagation` drag guards from Phase 1 to the popover content.

## Scope / sequencing

- Single PR, branched off `main`. Both phases touch only `EdgeVideo.tsx` + `EdgeVideo.module.scss`.
- Phase 1 is the bug fix (the "ongoing issue"); Phase 2 is the redesign asked for in the ticket.
  Could split into two commits in the same PR for reviewability.

## Verification

- Feed card (animated, muted-by-default) and lightbox/detail (`controls` on) both show controls on
  first load, no refresh needed, no flicker.
- Video with audio always shows the audio control; silent video hides it after metadata.
- Volume slider scrubs without dragging the video; value persists across videos (localStorage).
- Fullscreen: controls + volume popover visible and usable.
- Drag-to-canvas (the `imageId` drag feature) still works when dragging the video body.
- Cross-browser: Chrome, Safari (note existing Safari `w-full` + `preload='auto'` quirks), Firefox.

## Out of scope

- Native HTML5 controls path (`html5Controls=true`, used by `EdgeVideoWithControls`) — untouched.
- Seek/progress bar — current custom controls have none; not requested here.
