# Sound credits

The Kenney files come from Kenney (https://kenney.nl), published under Creative Commons Zero (CC0 1.0):
https://creativecommons.org/publicdomain/zero/1.0/ . Each pack page lists "License: Creative Commons CC0"
and each pack's License.txt reads "License: (Creative Commons Zero, CC0) ... free to use in personal,
educational and commercial projects. Crediting is not mandatory."
Pack pages: https://kenney.nl/assets/impact-sounds , /interface-sounds , /rpg-audio

Edits for every file: mono downmix, trimmed to length, short fade-out, re-encoded to Vorbis ogg (q3) and mp3 (64k).

| File | Pack | Original | Extra edit |
|---|---|---|---|
| press | Impact Sounds | Audio/impactWood_light_000.ogg | trim 0.10s |
| trial-correct | Interface Sounds | Audio/pluck_002.ogg | trim 0.16s |
| trial-wrong | Impact Sounds | Audio/impactSoft_medium_001.ogg | trim 0.15s, lowpass 600 Hz |
| gold | RPG Audio | Audio/handleCoins2.ogg | trim 0.22s |
| bell | Impact Sounds | Audio/impactBell_heavy_001.ogg | trim 1.5s |

## Synthesised (original, generated with ffmpeg; no third-party licence)

| File | Method |
|---|---|
| rankup | original, generated with ffmpeg: 4 detuned sawtooth partials (110, 110.8, 165, 220.9 Hz), double lowpass 650/900 Hz, 450ms attack swell, 400ms release, 1.4s |
| knighting-ring | original, generated with ffmpeg: inharmonic decaying sines (1630, 2310, 3470, 4980 Hz, exp decay) mixed with Kenney Impact Sounds impactMetal_light_000.ogg (CC0, https://kenney.nl/assets/impact-sounds) as the strike transient, 1.1s |
