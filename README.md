# Nutella Tsunami Manager

A web page for preparing microSD cards for the **Robertsonics Tsunami** WAV player and the
**Tesseract Modular Nutella Tsunami** Eurorack module. Drop in a pile of audio files and get a
Tsunami-ready card: converted, normalised, numbered, mapped to triggers and MIDI, checked, and
written straight to the card.

**Use it:** https://radio32.github.io/Tsunami-Manager/

Everything runs in the browser. No sound is uploaded anywhere, nothing needs installing, and
there is no build step. Use **Chrome or Edge** to write to the SD card and reach the hardware
(Web MIDI, Web Serial). Firefox and Safari can do everything else and save a ZIP instead.

## What it does

- **Pads:** the 16 trigger inputs × 256 trigger banks. Click a pad to audition it, double-click
  to browse for samples, drag to swap. Pads 1–8 are the kit pads (Kick, Snare, OHH, CHH, Clap,
  Perc 1, Perc 2, Cym): drop several files or whole folders on one and they're placed by name,
  with extra sounds of the same kind continuing in the next banks (up to 8 banks per drop).
  *Lanes* shows each trigger across banks; *Perform* emulates the hardware from the keyboard.
- **Tracks:** every track in one table, with search, filters and batch edits (numbering,
  normalise, gain, channels, MIDI flags, auto-trim, synced sets).
- **Inspector:** waveform with draggable trim and fades, silence trimming, reverse, peak or RMS
  normalisation, pan, channel handling, and A/B against the original. For mono firmware it can
  split a stereo file into a synced L/R pair.
- **MIDI map:** 32 MIDI banks × 128 notes, with the per-file `_L`/`_S` loop and output flags.
  Note names follow C3=60 (as in the Nutella manual) or C4=60.
- **Triggers:** all 14 trigger functions, Edge/Level/Latch, range, output, gain and flags, with
  presets (drum kits + bank switch, gate/sustain, round-robin, stem launcher…) and a live
  `tsunami.ini` preview.
- **Global settings:** firmware (mono/stereo) and board, output levels, output assignment
  (a trigger × output grid), debounce, MIDI, normalisation, dither and file naming. Open them from
  any page with **Global** or **G**.
- **Card doctor:** opens an existing card and shows what the Tsunami will see: duplicate numbers,
  wrong formats, metadata before the audio (the classic "file won't play"), wrong channel count,
  files in subfolders, macOS `._` junk. It repairs files in place, losslessly where it can, and
  converts mono to stereo.
- **Live:** Web MIDI to the Nutella's MIDI input and Web Serial to the Tsunami's serial header
  (3.3 V FTDI) to audition tracks and test triggers on the hardware.
- **Export:** a preflight report with one-click fixes, then **Write to SD card** (only changed
  files are written, and every file is read back and verified) or **Download ZIP**.

Projects autosave in the browser, audio included. Use *Settings → Save project bundle* to back
one up or move it to another computer.

## Defaults

- **Stereo firmware.** It won't play mono files, so mono sources are written as stereo on export.
- **Bank navigation on triggers 15/16.** New projects set T15 = Bank Down and T16 = Bank Up, so
  each bank is a 14-sound kit. Auto-numbering skips the 15/16 slots.
- **Themes.** Light and dark, matching the
  [Performer Library Manager](https://radio32.github.io/Performer-Library-manager/). Toggle in the
  header.

## Card rules it follows

From the Tsunami User Guide, the Robertsonics Configurator source
([WTConfig](https://github.com/robertsonics/WTConfig)) and the
[Nutella manual](https://docs.google.com/document/d/1n9J3baKEew5DDWzT5Faxcn1-AQwBXxvrJlFojfTVx9Y):

- WAV, 16-bit, 44.1 kHz; mono files for mono firmware, stereo for stereo. Exports always use a
  plain 44-byte header, so there's never metadata before the audio.
- Files sit in the card's root, named from the track number 1–4096, optionally followed by
  `_L`/`_S` + output 1–8 for MIDI loop/output.
- Trigger *n* in trigger bank *b* plays track `b·16 + n`; MIDI note *k* in MIDI bank *b* plays
  `b·128 + k`.
- `tsunami.ini` is written the way the official Configurator writes it, and only for settings
  that differ from the defaults.

## Tips

- Set debounce to **5 ms** for fast rolls and ratchets (Export offers it as a one-click fix).
- The Tsunami mixes voices digitally. If you layer many sounds, normalise to −6 dBFS rather than −1.
- Card check: after RESET the blue LED should blink 3 times right away. Class 4/10 non-UHS cards
  formatted FAT16/FAT32 work best.
- Switching firmware: put the `.hex` on the card as `tsunamix.hex`, hold USER and tap RESET until
  the LED is solid, then tap RESET again.

## Running it locally

- **macOS:** double-click `Start Manager.command`. It serves this folder on
  `http://127.0.0.1:8765` and opens Chrome.
- **Anywhere:** run `python3 -m http.server 8765` in this folder and open
  `http://127.0.0.1:8765/app/`.

Projects are stored per address, so keep the same URL and port.

## Tests

- Unit tests (ini, naming, WAV, ZIP): `node tests/run.mjs`, or on macOS without Node:
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/run.mjs`
- In-browser tests, from the app's console: `(await import('/tests/e2e.mjs')).run()`
