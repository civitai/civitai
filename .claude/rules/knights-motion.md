---
paths:
  - "apps/knights/src/global.css"
  - "apps/knights/src/motion.css"
  - "apps/knights/src/lib/motion.ts"
  - "apps/knights/src/lib/sound.ts"
  - "apps/knights/static/sounds/**"
  - "apps/knights/**/*.svelte"
---

# Knights motion and sound

Moved from `apps/knights/CLAUDE.md`. Tokens and easings are in `apps/knights/src/global.css`, keyframes in
`apps/knights/src/motion.css`. Keep play-loop motion to 200ms or less and never gate a submit on it; every
keyframe needs a reduced-motion counterpart; a new sound needs both files, `SOUND_NAMES` and `SOUND_LEVELS`
entries and a `CREDITS.md` line. Detail: [`docs/features/knights-motion-and-sound.md`](../../docs/features/knights-motion-and-sound.md).
