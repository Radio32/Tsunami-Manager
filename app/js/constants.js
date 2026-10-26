// Hardware facts for the Robertsonics Tsunami + Tesseract Nutella Tsunami.
// Sources: Tsunami User Guide (2023-01-14), Robertsonics WTConfig source,
// Tsunami Arduino Serial Library, Nutella Tsunami manual.

export const SAMPLE_RATE = 44100;
export const MAX_TRACK = 4096;
export const TRIGGERS = 16;
export const TRIGGER_BANKS = 256;   // 4096 / 16
export const MIDI_BANKS = 32;       // 4096 / 128

export const BOARDS = {
  original: { label: 'Tsunami (original)', mono: 32, stereo: 18 },
  qwiic:    { label: 'Tsunami Qwiic',      mono: 32, stereo: 18 },
  qwiic25:  { label: 'Tsunami Qwiic 25',   mono: 25, stereo: 13 },
};

// Trigger function codes exactly as written to #TRIG lines by the Configurator.
export const FUNCS = [
  { code: 1,  key: 'normal',  label: 'Normal',        short: 'PLAY',    range: false, plays: true,
    help: 'Plays track (bank × 16 + trigger). Affected by trigger bank.' },
  { code: 2,  key: 'next',    label: 'Next',          short: 'NEXT',    range: true,  plays: true,  edgeOnly: true,
    help: 'Each trigger plays the next track in the range, wrapping around.' },
  { code: 3,  key: 'prev',    label: 'Previous',      short: 'PREV',    range: true,  plays: true,  edgeOnly: true,
    help: 'Each trigger plays the previous track in the range, wrapping around.' },
  { code: 4,  key: 'random',  label: 'Random',        short: 'RAND',    range: true,  plays: true,  edgeOnly: true,
    help: 'Plays a random track from the range, never the same twice in a row (round-robin).' },
  { code: 5,  key: 'pause',   label: 'Pause',         short: 'PAUSE',   range: true,  plays: false,
    help: 'Pauses all tracks in the range. With Level type: momentary pause.' },
  { code: 6,  key: 'resume',  label: 'Resume',        short: 'RESUME',  range: true,  plays: false,
    help: 'Resumes paused tracks in the range.' },
  { code: 7,  key: 'stop',    label: 'Stop',          short: 'STOP',    range: true,  plays: false,
    help: 'Stops all tracks in the range. With Level type: stop and inhibit while held.' },
  { code: 8,  key: 'volup',   label: 'Volume Up',     short: 'VOL +',   range: false, plays: false,
    help: 'Raises the selected output volume by 1 dB per trigger.' },
  { code: 9,  key: 'voldn',   label: 'Volume Down',   short: 'VOL −',   range: false, plays: false,
    help: 'Lowers the selected output volume by 1 dB per trigger.' },
  { code: 10, key: 'midiup',  label: 'MIDI Bank Up',  short: 'MIDI B+', range: false, plays: false,
    help: 'Shifts MIDI notes to the next block of 128 tracks.' },
  { code: 11, key: 'mididn',  label: 'MIDI Bank Down',short: 'MIDI B−', range: false, plays: false,
    help: 'Shifts MIDI notes to the previous block of 128 tracks.' },
  { code: 12, key: 'bankup',  label: 'Trigger Bank Up',   short: 'BANK +', range: false, plays: false,
    help: 'Moves Normal triggers to the next bank of 16 tracks.' },
  { code: 13, key: 'bankdn',  label: 'Trigger Bank Down', short: 'BANK −', range: false, plays: false,
    help: 'Moves Normal triggers to the previous bank of 16 tracks.' },
  { code: 14, key: 'synced',  label: 'Synced Set',    short: 'SYNC',    range: true,  plays: true,  monoOnly: true,
    help: 'Mono firmware only: starts up to 8 tracks sample-locked on consecutive outputs.' },
];
export const FUNC_BY_CODE = Object.fromEntries(FUNCS.map(f => [f.code, f]));

export const TYPES = [
  { code: 0, label: 'Edge',  help: 'One-shot: starts on the trigger edge and plays until done.' },
  { code: 1, label: 'Level', help: 'Gate/sustain: plays only while the gate is high.' },
  { code: 2, label: 'Latch', help: 'Toggle: one trigger starts, the next one stops.' },
];

// #TRIG flag bits (Tsunami)
export const TF = {
  TYPE: 0x03, INTERFACE: 0x04, INVERT: 0x08, RETRIGGER: 0x10,
  LOOP: 0x20, POLY: 0x40, LOCK: 0x80,
};

export const BAUDS = [57600, 38400, 19200, 9600, 2400, 1200];

// Serial protocol (Tsunami Arduino Serial Library)
export const CMD = {
  GET_VERSION: 0x01, GET_SYS_INFO: 0x02, TRACK_CONTROL: 0x03, STOP_ALL: 0x04,
  OUTPUT_VOLUME: 0x05, TRIGGER_SET: 0x06, TRACK_VOLUME: 0x08, TRACK_FADE: 0x0a,
  RESUME_ALL_SYNC: 0x0b, SAMPLERATE_OFFSET: 0x0c, SET_REPORTING: 0x0d,
  SET_TRIGGER_BANK: 0x0e, SET_INPUT_MIX: 0x0f, SET_MIDI_BANK: 0x10,
};
export const TRK = { PLAY_SOLO: 0, PLAY_POLY: 1, PAUSE: 2, RESUME: 3, STOP: 4, LOOP_ON: 5, LOOP_OFF: 6, LOAD: 7 };
export const RSP = { VERSION: 0x81, SYS_INFO: 0x82, STATUS: 0x83, TRACK_REPORT: 0x84 };

export const AUDIO_EXT = /\.(wav|wave|aif|aiff|aifc|mp3|flac|ogg|oga|opus|m4a|aac|mp4|webm|caf)$/i;
