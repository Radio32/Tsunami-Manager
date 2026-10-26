# Tsunami Audio Project Manager Proposal

## Overview

This report proposes a web-based file and project manager for the original Robertsonic Tsunami audio player in conjunction with the Tesseract Nutella Tsunami module (the original card, not the Qwiic version). The goal is to create a workflow that helps users prepare, organize, validate, and export audio assets for a Tsunami-based playback system.

The product is not intended to replace a full DAW. Instead, it should act as a dedicated preparation and packaging tool for Tsunami-compatible media assets, with a strong emphasis on conversion, validation, normalization, and SD-card-ready export.

## Background and hardware constraints

From the Robertsonic Tsunami documentation and the Nutella Tsunami module specs, the core playback system is built around:

- uncompressed WAV playback
- 44.1 kHz sample rate
- 16-bit PCM audio
- up to 4096 files on SD card
- multiple voice/polyphony modes
- trigger-driven playback and MIDI control
- output routing and sample-synced playback features

This means the real opportunity is not general audio editing, but a workflow that turns source media into a valid Tsunami project with consistent naming, bank organization, format compliance, and predictable playback behavior.

## Core concept

Build a web app that allows a user to:

1. import source audio files from common formats
2. convert them to Tsunami-safe WAV files
3. remove metadata and metadata-related artifacts
4. normalize files for consistent playback levels
5. validate file format, metadata, naming, and size constraints
6. organize files into banks, trigger groups, and cue sets
7. export the final project as SD-card-ready content

This is a focused “asset pipeline” rather than a generic media library.

## Why this is feasible and useful

The Tsunami platform is highly capable but very specific. It rewards clean, consistent file preparation. A manager can create tremendous value by handling the tedious and error-prone work that otherwise has to be done manually.

The biggest practical problems are usually:

- files are in the wrong format
- metadata or embedded tags cause confusion or inconsistent playback behavior
- sample rate and bit depth are wrong
- files are not normalized for consistent volume
- file names and folder structures are inconsistent
- there is no clear trigger or bank mapping
- the user must manually prepare the SD card layout

A web-based management system addresses each of these directly.

## Recommended toolchain

### Primary processing engine: FFmpeg

FFmpeg is the best default choice for the audio tools in this project because it supports:

- conversion between source formats and WAV
- sample-rate conversion
- bit-depth conversion
- metadata stripping
- loudness normalization and peak limiting
- trimming and fades
- batch processing

Typical conversion output for Tsunami compatibility:

- sample rate: 44.1 kHz
- bit depth: 16-bit PCM
- channels: mono or stereo depending on project
- container: WAV

### Recommended backend stack

- Node.js or Python for processing jobs and file orchestration
- FFmpeg as the conversion and normalization engine
- SQLite for local project metadata and job state
- optional Postgres if the app grows to multi-user or shared-library use
- React or similar frontend framework for the browser UI

### Optional complementary tools

- SoX for advanced normalization and loudness workflows
- WaveSurfer.js for waveform previews
- custom metadata and validation layer for Tsunami-specific rules

## Proposed functionality

### 1. Asset ingest and library management

Features:

- drag-and-drop upload of audio files
- support for MP3, WAV, FLAC, AAC, OGG, AIFF, and others
- file tagging, notes, and project metadata
- folder and bank organization
- search and filtering by cue name, tag, bank, output, or trigger

### 2. Tsunami conversion pipeline

The system should define project presets such as:

- SFX preset
- Music loop preset
- Dialog preset
- Synced set preset
- Nutella trigger-focused preset

Each preset would map to target settings such as:

- 44.1 kHz
- 16-bit PCM
- mono or stereo output
- peak normalization target
- optional trim or fade handling
- filename sanitization rules

Example FFmpeg conversion:

```bash
ffmpeg -i input.mp3 -ar 44100 -acodec pcm_s16le -ac 2 output.wav
```

Mono version:

```bash
ffmpeg -i input.wav -ar 44100 -ac 1 -acodec pcm_s16le output_mono.wav
```

### 3. Metadata removal

Because the Tsunami hardware expects clean and predictable media, metadata removal is valuable.

Examples:

```bash
ffmpeg -i input.mp3 -map_metadata -1 -c:v copy -c:a pcm_s16le -ar 44100 -ac 2 output.wav
```

and:

```bash
ffmpeg -i input.wav -map_metadata -1 -f wav -ar 44100 -acodec pcm_s16le output.wav
```

This helps strip:

- ID3 tags
- album art
- embedded cue data
- extra metadata chunks that create inconsistent project behavior

### 4. Normalization and gain management

The system can support several normalization modes:

- peak normalization to a fixed limit
- loudness normalization for project mixes
- per-file gain adjustment
- batch normalization for a bank or cue set

Example peak normalization:

```bash
ffmpeg -i input.wav -af "volume=0.9" -ar 44100 -acodec pcm_s16le output.wav
```

For limiting to safe playback levels:

```bash
ffmpeg -i input.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -acodec pcm_s16le output.wav
```

This can be tuned based on whether the material is music, SFX, or dialog.

### 5. Validation layer

The app should preflight every file before export. It should check:

- valid WAV format
- correct sample rate
- correct bit depth
- mono or stereo match expected target
- file size within practical SD constraints
- file count within project limits
- valid naming convention
- optional loop/trim consistency

This is one of the most valuable features because it prevents failed SD card preparation.

### 6. Trigger, bank, and output mapping

The Tsunami ecosystem is trigger-driven, so the manager should support project mapping data such as:

- trigger number to sample or group
- MIDI note to sample or output
- output routing assignments
- random trigger range assignment
- loop-mode configuration
- synced-set grouping

The app can represent this as a structured project file or config template, not just a file list.

### 7. SD card export and packaging

The final stage should package the project for deployment:

- multi-bank folder layout
- WAV files renamed and organized by trigger number or cue ID
- optional project config export
- ZIP bundle for transfer to a computer
- direct SD card export or image generation if supported
- checksum manifest for verification

This turns the app into a real deployment tool, not just a conversion utility.

### 8. Preview and editing helpers

Useful optional features:

- waveform preview
- trim start/end points
- fade in/out control
- silence trimming
- loop point visualization
- cue naming and notes
- quick playback check in browser

This helps with preparing file sets that will later be routed and triggered in hardware.

## Proposed data model

A simple but useful project object might include:

- project name
- author / owner
- source assets
- target preset
- output mode (mono or stereo)
- bank structure
- trigger mapping
- normalization profile
- validation results
- final export bundle

The project database can track:

- original source files
- converted output files
- metadata cleanup status
- job logs
- export status
- warnings and errors

## Suggested user experience

A web app could work as follows:

1. User creates a new project.
2. User uploads source audio files.
3. User chooses target preset: Fire/SFX, Music, Dialog, Nutella Trigger Layout, etc.
4. System validates files and previews them.
5. User batch-converts everything to Tsunami-safe WAV.
6. User reviews normalization and loop/trim decisions.
7. User assigns bank, trigger, or MIDI mappings.
8. User exports an SD-ready project package.
9. User writes the package to SD and loads it into the hardware.

This is a clean and understandable workflow.

## Example FFmpeg workflow for a Tsunami-ready bank

```bash
# Convert all sources to 44.1kHz 16-bit WAV
for f in *.mp3; do
  ffmpeg -hide_banner -loglevel error -i "$f" -ar 44100 -acodec pcm_s16le -ac 2 "${f%.mp3}.wav"
done

# Remove metadata and normalize
ffmpeg -i input.wav -map_metadata -1 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -acodec pcm_s16le output.wav
```

Then use the app to:

- rename files for trigger groups
- assign output routing
- build a SD folder structure
- generate an export package

## What makes this product distinct

This is not a generic file manager; it is a Tsunami-specific audio preparation platform. That narrows the scope in a good way:

- it supports the exact hardware constraints
- it reduces user error for conversion and organization
- it creates a repeatable project pipeline
- it makes the original Tsunami and Nutella setups easier to manage

## Recommended first release scope

For an initial build, focus on:

- audio ingestion
- conversion to Tsunami-safe WAV
- metadata stripping
- sample-rate and bit-depth validation
- normalization presets
- project folder organization
- bank/trigger mapping UI
- SD export bundle

This delivers the highest value with the least risk.

## Recommended later features

Once the core flow works, add:

- waveform editing
- loop point marking
- stem sync grouping
- per-project presets
- MIDI mapping export
- custom SD project templates
- cloud/project-sync features
- reusable sample libraries

## Risks and considerations

- The Tsunami platform is strict about format and structure, so validation must be robust.
- The app needs clear “this file is safe for Tsunami” states rather than vague audio quality checks.
- Naming conventions and export structure should be configurable to match the user’s hardware conventions.
- Some users may want a project to be “playable without any manual editing,” so the app should minimize manual steps.

## Recommendation

Proceed with a specialized Tsunami project manager focused on:

- file conversion
- metadata removal
- normalization
- validation
- organization into banks and triggers
- SD-card export

FFmpeg should be the primary processing engine, with a browser-based workflow layered on top.

This approach is practical, aligned with the original hardware, and highly useful for anyone running Robertsonic Tsunami or Nutella Tsunami systems.

## Summary

The best outcome is a web app that acts as a Tsunami project pipeline: import source audio, convert to compliant files, strip metadata, normalize audio, validate the result, and export a clean SD-ready project.

This is a realistic and valuable product for the original Tsunami ecosystem and the Tesseract Nutella Tsunami module.
