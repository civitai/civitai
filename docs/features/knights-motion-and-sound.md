# Knights of New Order: motion and sound

Moved from `apps/knights/CLAUDE.md`.

The design is the Pencil file's M0-M8 storyboards and S1. Motion tokens and easings are in `src/global.css`; shared keyframes (and their reduced-motion fades) are in `src/motion.css`, helpers (`tween`, `skippable`, `reducedMotion`) in `src/lib/motion.ts`.

- Play-loop motion (answer press, image crossfade, reward floaters) is 200ms or less and never gates the submit: the vote posts at the click, nothing waits on an animation end. Milestones (seal stamp, Watch complete, rank-up, knighting) are 600-1200ms and skippable with `use:skippable` (a click or key sets `data-skipped`, which drops every animation under it).
- Reduced motion: `motion.css` redefines each keyframe as an opacity fade and `global.css` caps durations at 150ms and zeroes delays. Do not animate translate, scale or clip outside a keyframe that has a reduced counterpart.
- Sound: `src/lib/sound.ts` (`sound.play(name)`), files in `static/sounds` (.ogg and .mp3, credits in `CREDITS.md`). It plays nothing before the first click, key or touch, swallows every failure, debounces `press`, and a per-player mute (`knights:sound-muted:<userId>` in localStorage, default on) lives in the avatar menu's Sound switch. A new sound needs both files, an entry in `SOUND_NAMES` and `SOUND_LEVELS`, and a line in `CREDITS.md`. Stamps and smite are silent on purpose.
- Rewards: `lib/rewards.ts` turns a status change into the floating "+XP"/"+gold" and the gold sound; both are read in `AppHeader.svelte`.
