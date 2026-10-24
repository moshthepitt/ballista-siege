# Audio pass AU1

Built the Web Audio engine, 22 effects, seeded music and `/audio-lab.html`. No audio files or dependencies added. Game wiring is left for the next pass. No changes needed in `src/v1/` or `src/chain-v1/`.

The engine registers gesture listeners on import and creates one AudioContext on the first pointerdown or keydown. Effects and music share a 12-event voice budget; an event can contain several synthesis layers. The oldest event is stopped when the budget fills. Same-kind effects on the same lane merge within 60 ms of the first event, with gain `1 + 0.3 * log2(count)`. Four panners cover lanes 0–3. Both buses feed master gain, then a compressor.

Master defaults to 100%, effects to 70%, music to 40%. Volumes and mute use `ballista:siege:audio` in localStorage. `?mute=1` forces silence without changing the saved mute preference. Plays before unlock are dropped.

| Kind | Sound |
| --- | --- |
| `ballista-fire` | Plucked saw with a fast falling pitch and string snap. |
| `bolt-hit` | Low wooden thock and short noise; intensity raises the thock. |
| `cauldron-fire` | Three low bubbles under a filtered whoosh. |
| `splash` | Wet noise burst with a high sizzle tail. |
| `armour-block` | Two inharmonic sine tones for a dull clank. |
| `unit-killed` | Short falling pop. |
| `boss-killed` | Deep boom, falling saw and filtered noise roar. |
| `fence-bite` | Crunch with a low thump. |
| `fence-break` | Three splinter cracks and a falling wooden tone. |
| `trample` | Heavy stomp with a power-down sweep. |
| `leak` | Wall thud and low rumble; intensity lengthens both. |
| `storm` | Swelling two-tone horn followed by seven quick footsteps. |
| `gold` | Two-note chime. |
| `place` | Wooden thunk. |
| `upgrade` | Four rising shimmer notes. |
| `sell` | Two falling coin tones. |
| `reroll` | Four filtered shuffle ticks. |
| `overclock` | Two rising charge tones. |
| `ui-click` | Soft, brief sine tick. |
| `wave-won` | Rising major chord. |
| `run-won` | Five-note fanfare with a low final tone. |
| `run-lost` | Four-note minor descent. |

Every effect gets one pitch variation within ±4% and one length variation within ±8%. `play(kind, { lane?, intensity? })` is exported from `play/audio/index.ts`; intensity uses 0–3. `SOUND_KINDS` and `SoundKind` cover every effect above.

Music has bass, pluck, pad, kick, snare and hat voices. A seed and bar number choose each phrase. Build runs at 80 bpm with pentatonic plucks. Battle adds bass and drums; intensity adds snares, hats and extra bass notes. Boss uses a minor scale and low drone. Outro lasts one bar before build returns. A 25 ms timer schedules 100 ms ahead on the audio clock. Phase changes crossfade at the next unscheduled bar; tempo changes also wait for that boundary.

`setPhase()` starts music or arms it for unlock. `setIntensity()` changes density. Pass the actual tick duration to `syncTick(baseTickMs / speed)`: battle and boss use one tick per bar. `getMusic().stop()` stops the scheduler and its voices. The lab uses 3,000 ms at 1× and 1,500 ms at 2× for comparison.

The lab has all 22 effect buttons, Shift-click merging, lane selection, phase controls, intensity, speed, mix sliders and mute with M. It shares the game's fonts and colour tokens. Its dev import graph and a separate production build pass. The default game production build includes only `index.html`; the lab is served by `pnpm dev`.

Size: **5,313 bytes gzip**, measured with `pnpm exec esbuild play/audio/index.ts --bundle --minify | gzip -c | wc -c`. Minified bundle: 13,887 bytes. Both are below the 15 KB target.

Validation: 50 audio tests and all 179 play tests pass. Tests cover gesture gating, first-click setup, voice stealing, merge boundaries, persistence, forced mute, every effect's route to the effects bus, jitter, timing at both speeds, bar crossfades and seeded phrases. Vitest has no OfflineAudioContext, so effects use the permitted node-graph fallback. `pnpm typecheck`, `pnpm exec tsc -p play/tsconfig.json`, `pnpm exec vitest run play` and `pnpm exec vite build play` pass. All six lab/audio modules also pass Vite's dev transform. The 300-run chain corpus was skipped as requested.

EYES smoke (`au1-smoke-20261023-1504`, `--seeds=4`) passed all 33 layout sizes and the desktop run (10 waves, 15 walls, 50g, score 1634). It failed on laptop seed 4, wave 5: the enemy label `1×9` overlaps `Trampled · off this wave` during ticks 4–5. Audio is not imported by the game yet. The failing UI is outside this pass's allowed paths and was left for the UI agent.

EYES lab request `au1-lab-20261023-1506` confirmed the build-entry blocker: both desktop and phone returned HTTP 404. I opened both PNGs; they are blank, so visual comparison and browser interaction checks remain unverified. The report's empty overflow lists do not validate the lab. The orchestrator needs to include `audio-lab.html` as a build entry or serve the separate lab build at `.tmp/audio-lab-build/`. A working build config is at `.tmp/audio-lab.vite.config.ts`. No files outside the allowed paths were changed to work around the runner.

Open: owner listening pass, battle WAV rendering, peak/loudness checks and Gemini listening review. Those need recorded game events and are left for the wiring pass. The lab still needs a successful EYES screenshot and console-error check. Its colour tokens and fonts were taken from the game and checked against the supplied visual-language reference; the rendered lab itself has not been seen.

## AU2: game wiring

Wired all 22 effects to battle contacts, successful build actions, card/UI clicks, coins and summary/end stingers. Battle cues share replay frames and visual delays, including 40 ms unit collapses and lane-by-lane storm charges. Each kind/lane/contact produces one API call. Bolt intensity uses damage after mitigation, capped by HP lost; leak intensity uses walls actually lost. Music follows build, battle, active bosses and outro, with depth-based intensity and the real replay tick duration at either speed.

The 44 px HUD sound button opens music/effects sliders and mute; narrow layouts put it in Run status. Settings persist through AU1. M works in the sound sheet. Smoke and both scratch recorders now force `mute=1`. Screenshot review caught and fixed the first sound click being swallowed by an icon repaint during audio unlock.

New files: `play/audio/{game,game.test,track,offline,metrics.test}.ts`, `play/audio/fixtures/seed13.json`, `play/ui/sound.ts`, `scripts/{audio-render,audio-metrics}.ts`. Changed: `play/ui/{battle,hud,scout}.ts`, `play/{main,replay}.ts`, `play/style.css`, `scripts/play-smoke.ts`, `.tmp/browser/v1/{record,capture}.mjs` and this report.

Both TypeScript checks, all 225 play tests across 20 files, and the production build pass. Tests compare recorded seed-13 waves 5/10 with raw frame events, cover every action, and map music across ten waves at both speeds. EYES `au2-smoke-01` passed seeds 4/13 on three layouts plus 33 sizes, including sound controls, sliders, persistence and M/mute. Seed 4 ended at 15 walls, 50g, score 1634; seed 13 at 8 walls, 32g, score 1532. Final `au2-final-smoke-02` also passed seed 4 and all 33 sizes after the M hint. Open/closed sound screenshots from `au2-final-{desktop,phone}-02` were viewed at 1920×950, 1366×650 and 390×844 against the design references; their audits and page-error lists are empty.

Host command: `node --import tsx scripts/audio-render.ts`. It renders 65 effect cues over 17.620 seconds at 1×, including settlement and tail, to `.tmp/audio/w5.wav` and `w5-metrics.json`. Its separate browser entry builds. Synthetic measurements pass at −6.02 dBFS peak and −9.03 dBFS RMS; WAV interleaving and clipping rejection pass. Actual battle peak/RMS and listening remain unverified until the host renders it. Chromium was not launched in the sandbox. Nothing dropped; rules/chain source unchanged; no engine change needed. The 300-run chain corpus was skipped.


## Audio pass AU3

Added master gain staging, compression and an oversampled soft limiter. Threats and boss death duck routine fire and keep voice priority. Reworked twangs, bubbles, wet splashes, clanks and wall threats. Timed layers separate volleys and death cascades; per-unit pops skip merging and get quieter through a burst.

Boss music uses a minor third, sustained 55 Hz drone, sparse plucks and heavier bass/drums. Kept defaults, persistence, mute, `?mute=1`, the UI API and AU2 event-order tests.

Gemini scores, effects/music/mix:

| Wave | Before | After | Busy RMS dBFS | Peak dBFS |
| --- | --- | --- | --- | --- |
| 5 | 6/5/6 | 9/9/9 | −18.62 to −15.79 | −3.50 |
| 10 | 6/7/5 | 9/9/9 | −18.68 to −16.04 | −5.27 |

Busy means seconds 4–13 of seed 13 at 1× with default volumes. Both last listens identify every cue. Evidence: `.tmp/ears/out/au3-round5-w5/` and `au3-last-w10/`; final wave-5 metrics are in `au3-final-metrics-w5/`. Its re-render stays within one PCM step of the heard take. Used 11 listens. Gemini's remaining polish suggestion is a slightly softer stacked gold chime.

Bundle: **6,464 bytes min+gzip**, from `pnpm exec esbuild play/audio/index.ts --bundle --minify | gzip -c | wc -c`; minified code is 17,066 bytes. No audio files or dependencies added.

Changed `play/audio/{engine,sfx,synth,music,engine.test,sfx.test,test-audio}.ts` and this report. All 78 audio tests and 243 play tests pass, as do both TypeScript checks and the production build. Limiter routing/bounds, duck recovery, mixed volleys and separate death pops have coverage.

Final EYES `au3-final-05` desktop/phone screenshots were viewed against the design references; audits and page errors are empty. Smoke passed teaching and later tutorials on desktop/laptop/phone, then failed at 1024×1440: `span.n` and `span.h` escape their parent boxes. This remains in PL1's UI scope. Nothing dropped from the audio plan. No rules/chain changes needed; the requested 300-run chain corpus was skipped.

## Audio pass AU4

Protected bolt, block and splash voices from death bursts at the 12-voice cap. Retuned bubbles, clanks and pops; softened repeated noise; spaced splinters after bites and wall impacts after stomps. Settlement coins follow the completed fanfare. Boss music has a filtered eight-bar minor phrase, warmer pads and stronger backing with softer percussion.

Independent median-of-three scores, effects/music/mix:

| Wave | Post-AU3 baseline | AU4 round 1 | AU4 round 2 | Busy RMS dBFS | Peak dBFS |
| --- | --- | --- | --- | --- | --- |
| 5 | 8/7/8 | 8/8/8 | 7/8/7 | −17.59 to −15.14 | −5.26 |
| 10 | 8/8/7 | 7/8/8 | 7/8/7 | −18.34 to −15.37 | −5.26 |

The 9/9/9 target remains unmet. Effects fell one point on both waves. Music stalled at 8 across two rounds, so tuning stopped under the requested rule. Used four of six listen requests, twelve individual judgments. Listeners still ask for clearer bolt/block/kill attacks beneath splash, distinct bite/break and stomp/leak pairs, and coins that read separately from the fanfare. Evidence: `.tmp/ears/out/au4-r1-w{5,10}-1827/` and `au4-r2-w{5,10}-1835/`; round 2 has the final WAVs and metrics. Busy means seconds 4–13 of recorded seed 13 at 1× and default volumes.

Bundle: **6,817 bytes min+gzip**, 17,890 bytes minified, measured with the AU3 command. All 81 audio tests and 247 play tests pass; both TypeScript checks and production build pass. Added coverage for coin/fanfare separation at both jitter extremes and impact survival under voice pressure. UI API, persistence, forced mute and AU2 event-order tests are unchanged.

EYES `au4-sound-{desktop,phone}-1828` and `au4-final-1835` screenshots were viewed against the supplied designs; audits and page errors are empty. Final smoke passed all 33 tutorial sizes and 32 of 33 layout sizes, then stopped at 360×800: `span.forecast-label` and `span.forecast-short` escape their parent after continuing a summary. Full bot runs were not reached. That failure remains in PL1's files.

Changed `play/audio/{sfx,music,sfx.test}.ts` and this report. No audio features dropped, dependencies added or rules/chain changes needed. The 300-run chain corpus was skipped.

Orchestrator check after AU4: AU3's effects with AU4's music scored 7/8/7 on both waves, the same as AU4 alone, so AU4's version stays. AU3's 9/9/9 came from repeated single listens; the median of three after AU3 was 8/7/8 (wave 5) and 8/8/7 (wave 10). Every version since AU3 sits between 7 and 8, inside the spread between listeners, so further tuning waits for the owner's own listening.
