# Nutella Tsunami Manager

A browser-based card manager for the **Robertsonics Tsunami** WAV player and the **Tesseract Modular Nutella Tsunami** Eurorack module. It turns any pile of audio files into a Tsunami-ready microSD card: converted, normalized, numbered, mapped to triggers and MIDI, validated and written straight to the card.

Everything runs locally in the browser. Nothing is uploaded, nothing needs installing, and there is no build step.

## Running it

- **macOS:** double-click `Start Manager.command`. It serves this folder on `http://127.0.0.1:8765` and opens Chrome.
- **Anywhere:** `python3 -m http.server 8765` in this folder, then open `http://127.0.0.1:8765/app/`.

Use **Chrome or Edge** for direct SD-card writing (File System Access API), Web MIDI and Web Serial. Firefox and Safari can do everything else and export a ZIP instead.

Projects autosave in the browser, audio included. The browser stores them per address, so keep the same URL/port. Use *Settings → Save project bundle* to back up a project or move it to another computer.

## Defaults for this setup

- **Stereo firmware.** The stereo firmware won't play mono files, so every mono source is written as stereo (same signal on L and R) on export, and Tracks marks it `M→S`. Files already on a card or in a sample folder can be converted in the **Card doctor** (*Convert mono → stereo*): overwrite in place, write copies to another folder, or download a ZIP.
- **Bank navigation on triggers 15/16.** New projects set T15 = Trigger Bank Down and T16 = Trigger Bank Up. Each bank is then a 14-sound kit (tracks 1–14, 17–30, 33–46…). Auto-numbering and "next free" skip the 15/16 slots, and the preflight flags any track that lands there, since no trigger can reach it.
- **Global drawer.** The **Global** button (or **G**) opens firmware, output levels, output assignment, debounce, MIDI and processing from any page.
- **Output assignment.** A trigger × output grid (4 stereo pairs: jacks 1/2, 3/4, 5/6, 7/8) in the Global drawer and on Settings, a quick output button on every pad, and an output picker in the inspector. It's written to the `#TRIG` output field, so it applies to that pad in every bank.
- **Pan.** Per-track pan in the inspector (and *Pan…* for several tracks in Tracks), written into the exported WAV. It's balance-style: centre is unchanged and the far side fades out, so panning never adds clipping.
- **Themes.** *Night* and *Parchment*, built from the project mood board (Deep Emerald, Verdigris, Turquoise, Cosmic Teal, Night Blue, Moss Green, Desert Sand). Toggle in the header.

## What it does

| Page | Purpose |
|---|---|
| **Pads** | The 16 trigger inputs × 256 trigger banks. **Click** a pad to audition it, **double-click** to browse for samples, drag pads to swap. **Pads 1–8 are the kit pads** (Kick, Snare, OHH, CHH, Clap, Perc 1, Perc 2, Cym, tinted differently): drop or browse several files onto one of them and the files are recognised by name and offered in a placement dialog. Several files on pads 9–14 fill those pads in name order. Each pad has a quick output button (→1…→4). *Lanes* shows each trigger across banks. *Perform* emulates the hardware. Keys 1–8 and Q–I play the triggers. |
| **Tracks** | Every track in a table: search, filters, multi-select batch edits (number from…, normalize, gain, channels, MIDI flags, auto-trim, synced set). |
| **MIDI map** | 32 MIDI banks × 128 notes (track = bank × 128 + note), with the per-file `_L3`/`_S4` loop/output flag. Note names follow either C3=60 (as in the Nutella manual) or C4=60. |
| **Triggers** | All 14 trigger functions, Edge/Level/Latch, range, output, gain, retrigger/poly/loop/lock. Presets: drum kits + bank switch, gate/sustain, round-robin, stem launcher, one output per trigger. A live `tsunami.ini` preview. |
| **Settings** | Firmware mode (mono/stereo) and board (original / Qwiic / Qwiic 25), output volumes, input mix, debounce (`#DBNC`), MIDI channel/bend/release/velocity/note-off, normalization defaults, dither, file-naming rules. |
| **Card doctor** | Open an existing card to see what Tsunami will see: duplicate track numbers, wrong formats, **metadata chunks before the audio** (the classic "file won't play" cause), wrong channel count for the firmware, lower-case MIDI flags, WAVs in subfolders, macOS `._` files. It can repair files in place (losslessly where possible), clean junk, or import the card into a project. |
| **Live** | Web MIDI to Nutella's MIDI input (audition tracks on the hardware, Program Change for MIDI banks, output-volume/attack/release CCs). Web Serial to the Tsunami serial header via a 3.3 V FTDI (version/track count, play/stop, banks, volumes, and the Configurator-style trigger "Test"). |
| **Export** | Preflight report with one-click fixes, then **Write to SD card** (incremental: unchanged files are skipped, same-number conflicts are cleaned up, every file is read back and verified) or **Download ZIP**. |

### Per-track inspector

Waveform with draggable trim and fade handles, auto-trim of silence, fade curves, reverse, peak or RMS normalization with gain on top, channel handling (sum/left/right for mono firmware; as-is/mono/left/right/swap for stereo), and A/B against the original. For mono firmware you can **split a stereo file into a synced L/R pair** played sample-locked by one trigger.

## Hardware rules it enforces

From the Tsunami User Guide (2023-01-14), the Robertsonics Configurator source ([WTConfig](https://github.com/robertsonics/WTConfig)) and the [Nutella manual](https://docs.google.com/document/d/1n9J3baKEew5DDWzT5Faxcn1-AQwBXxvrJlFojfTVx9Y):

- WAV, 16-bit PCM, 44.1 kHz. Mono files for the mono firmware, stereo files for the stereo firmware. No metadata before the audio. Exports always use a canonical 44-byte header (`RIFF/fmt/data`), so metadata is stripped by design.
- Files sit in the root folder, and the name starts with the track number 1–4096. An optional `_L`/`_S` + output 1–8 directly after the number sets MIDI loop/output. A label that would be misread as that flag (e.g. `0007_S2 bass`) gets a different separator.
- Trigger *n* in trigger bank *b* plays track `b·16 + n`. MIDI note *k* in MIDI bank *b* plays `b·128 + k`.
- `tsunami.ini` is written the way the official Configurator writes it (`#TSUS`/`#TSUM`, `#TRIG NN, flags, gain, output, function, low, high`, `#VOLn`, `#MCHN`, …), and only for non-default settings. `#DBNC` (debounce) comes from the Nutella manual.
- Synced Set: mono firmware only, at most 8 tracks, and it must not run past output 8.

## Project layout

```
app/
  index.html, css/app.css
  js/constants.js   hardware facts, function codes, serial opcodes
  js/ini.js         tsunami.ini build/parse (Configurator-compatible)
  js/naming.js      track-number file names
  js/wav.js         16-bit WAV encoder, RIFF inspector, lossless rewrap, AIFF decoder
  js/audio.js       decode/resample, edit chain, analysis, playback
  js/validate.js    preflight rules
  js/export.js      SD-card folder writer, ZIP, project bundles
  js/importer.js    file/ini/bundle import
  js/sim.js         in-browser trigger emulation
  js/live.js        Web MIDI + Web Serial
  js/state.js       project model, undo/redo, autosave (IndexedDB)
  js/views/*        one module per page + inspector + waveform
tests/
  run.mjs           unit tests (ini/naming/wav/zip). Run with node or macOS jsc:
                    /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/run.mjs
  e2e.mjs           in-browser pipeline tests. In the app's console:
                    (await import('/tests/e2e.mjs')).run()
```

## Tips

- Set **debounce to 5 ms** for fast rolls and ratchets (the Export page offers it as a one-click fix).
- Tsunami mixes voices digitally before the output stage. If you layer many sounds, normalize to −6 dBFS rather than −1.
- Card health check: after RESET the blue LED should blink 3 times right away. Class 4/10 non-UHS cards formatted FAT16/FAT32 work best.
- Switching firmware: put the `.hex` on the card as `tsunamix.hex`, hold USER and tap RESET until the LED is solid, then tap RESET again.
