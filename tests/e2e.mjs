// In-browser end-to-end checks. Open the app, then in the console:
//   const { run } = await import('/tests/e2e.mjs'); await run();
// (served from the repo root, e.g. `python3 -m http.server` in the project folder)

const A = '/app/js/';
const results = [];
const ok = (cond, name, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

function wavBytes({ rate = 44100, bits = 16, ch = 1, frames = 4410, fmtTag = 1, extraBefore = null, freq = 440 }) {
  const bps = bits / 8, dataLen = frames * ch * bps;
  const extra = extraBefore ? 8 + extraBefore.length + (extraBefore.length & 1) : 0;
  const buf = new ArrayBuffer(44 + extra + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, fmtTag, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true);
  let o = 36;
  if (extraBefore) { str(o, 'LIST'); v.setUint32(o + 4, extraBefore.length, true); str(o + 8, extraBefore); o += extra; }
  str(o, 'data'); v.setUint32(o + 4, dataLen, true); o += 8;
  for (let i = 0; i < frames; i++) {
    const s = Math.sin(2 * Math.PI * freq * i / rate) * 0.5;
    for (let c = 0; c < ch; c++, o += bps) {
      if (fmtTag === 3) v.setFloat32(o, s, true);
      else if (bits === 16) v.setInt16(o, Math.round(s * 32767), true);
      else if (bits === 24) { const x = Math.round(s * 8388607); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); }
    }
  }
  return new Uint8Array(buf);
}

function aiffBytes({ rate = 48000, frames = 4800 }) {
  const dataLen = frames * 2;
  const buf = new ArrayBuffer(12 + 26 + 16 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'FORM'); v.setUint32(4, buf.byteLength - 8); str(8, 'AIFF');
  str(12, 'COMM'); v.setUint32(16, 18); v.setUint16(20, 1); v.setUint32(22, frames); v.setUint16(26, 16);
  // 80-bit extended 48000: exponent 16383+15 = 0x400E, mantissa 48000 << 48
  v.setUint16(28, 0x400e); v.setUint32(30, 0xbb800000); v.setUint32(34, 0);
  str(38, 'SSND'); v.setUint32(42, 8 + dataLen); v.setUint32(46, 0); v.setUint32(50, 0);
  for (let i = 0; i < frames; i++) v.setInt16(54 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * 16000));
  return new Uint8Array(buf);
}

export async function run() {
  results.length = 0;
  const wav = await import(A + 'wav.js');
  const audio = await import(A + 'audio.js');
  const st = await import(A + 'state.js');
  const zip = await import(A + 'zip.js');
  const ini = await import(A + 'ini.js');
  const exp = await import(A + 'export.js');
  const imp = await import(A + 'importer.js');

  // 1. inspector detects metadata before audio and wrong formats
  const bad = await wav.inspectWav(new Blob([wavBytes({ extraBefore: 'INFOISFTLogic Pro' })]));
  ok(!bad.ok && bad.problems.some(p => p.code === 'meta'), 'LIST before data is flagged', bad.chunkSummary);
  const hi = await wav.inspectWav(new Blob([wavBytes({ rate: 48000, bits: 24, ch: 2 })]));
  ok(!hi.ok && hi.problems.filter(p => p.code === 'format').length === 2, '48k/24-bit flagged twice');
  const good = await wav.inspectWav(new Blob([wavBytes({})]));
  ok(good.ok, 'clean 44.1/16 mono passes');
  const re = await wav.rewrapPcm16(new Blob([wavBytes({ extraBefore: 'INFOx' })]), await wav.inspectWav(new Blob([wavBytes({ extraBefore: 'INFOx' })])));
  const reInfo = await wav.inspectWav(new Blob([re]));
  ok(reInfo.ok && reInfo.chunkSummary === 'fmt · data', 'lossless rewrap strips LIST', reInfo.chunkSummary);

  // 2. decode + resample odd formats
  const d48 = await audio.decodeBytes(wavBytes({ rate: 48000, bits: 24, ch: 2, frames: 48000 }).buffer);
  ok(Math.abs(d48.channels[0].length - 44100) <= 2 && d48.channels.length === 2, '48k 24-bit stereo → 44.1k', `${d48.channels[0].length} frames, origRate ${d48.origRate}`);
  const df = await audio.decodeBytes(wavBytes({ fmtTag: 3, bits: 32, frames: 4410 }).buffer);
  ok(df.channels[0].length === 4410, '32-bit float WAV decodes');
  const da = await audio.decodeBytes(aiffBytes({}).buffer);
  ok(Math.abs(da.channels[0].length - 4410) <= 2 && da.origRate === 48000, 'AIFF 48k decodes + resamples', `${da.channels[0].length} frames`);

  // 3. render chain
  const proj = { ...st.newProject(), mode: 'mono' };
  const tr = st.newTrack({ edits: { ...st.defaultEdits(), trimStart: 0.1, trimEnd: 0.6, fadeOut: 50 } });
  const r = audio.renderChannels(tr, d48, proj);
  ok(r.channels.length === 1 && Math.abs(r.channels[0].length - 22050) <= 1, 'mono render: 1 ch, trimmed to 0.5 s', `${r.channels[0].length}`);
  ok(Math.abs(r.peakDb - -1) < 0.05, 'peak normalized to −1 dBFS', r.peakDb.toFixed(2));
  ok(Math.abs(r.channels[0][r.channels[0].length - 1]) < 1e-3, 'fade-out reaches silence');
  const rs = audio.renderChannels(st.newTrack({ edits: st.defaultEdits() }), df, { ...proj, mode: 'stereo' });
  ok(rs.channels.length === 2, 'mono source → stereo render duplicates');
  const enc = wav.encodeWav16(r.channels);
  const encInfo = await wav.inspectWav(new Blob([enc.bytes]));
  ok(encInfo.ok && encInfo.fmt.channels === 1 && encInfo.fmt.rate === 44100 && encInfo.fmt.bits === 16, 'encoded file is Tsunami-safe', encInfo.chunkSummary);

  // 4. export plan of the live project + zip round trip
  const live = st.state.project;
  const plan = exp.planExport(live);
  const zw = new zip.ZipWriter();
  for (const p of plan.slice(0, 4)) {
    const rr = await audio.getRendered(p.track, live);
    zw.add(p.fileName, wav.encodeWav16(rr.channels).bytes);
  }
  zw.add('tsunami.ini', ini.buildIni(live));
  const back = await zip.readZip(zw.blob());
  ok(back.length === Math.min(4, plan.length) + 1, 'zip round trip', back.map(f => f.name).join(', '));
  if (back.length > 1) ok((await wav.inspectWav(new Blob([back[0].data]))).ok, 'wav inside zip is valid');

  // 5. importer: numbered names
  const files = [new File([wavBytes({ frames: 2000 })], '0200_S3 test tone.wav'), new File([wavBytes({ frames: 2000 })], 'no number.wav')];
  const before = live.tracks.length;
  await imp.importFiles(files, { useNames: true });
  const t200 = st.state.project.tracks.find(t => t.num === 200);
  ok(st.state.project.tracks.length === before + 2 && t200 && t200.midi.out === 3 && t200.name === 'test tone', 'import keeps number + MIDI flag', t200 && `${t200.name} out ${t200.midi.out}`);

  // 6. simulator: random trigger never repeats, synced set starts together
  const sim = await import(A + 'sim.js');
  st.update(p => { p.triggers[0] = { ...ini.applyFunctionDefaults(p.triggers[0], 4), low: 1, high: 4 }; }, { reason: 'trigger' });
  const seen = [];
  for (let i = 0; i < 12; i++) { await sim.press(1); seen.push(sim.sim.lastRandom[1]); }
  ok(seen.every((n, i) => i === 0 || n !== seen[i - 1]) && seen.every(n => n >= 1 && n <= 4), 'random: no immediate repeats', seen.join(','));
  sim.stopAllSim();
  st.update(p => { p.triggers[0] = ini.defaultTrigger(1); }, { reason: 'trigger' });

  // 7. stereo split creates consecutive L/R + synced trigger
  const acts = await import(A + 'actions.js');
  const stereoFile = new File([wavBytes({ ch: 2, frames: 2000 })], 'stereo pad.wav');
  const [res] = await imp.importFiles([stereoFile], { autoNumber: 300 });
  const sid = st.state.project.tracks.find(t => t.sourceId === res.sourceId).id;
  acts.splitStereo(sid, 16);
  const L = st.state.project.tracks.find(t => t.id === sid);
  const R = st.state.project.tracks.find(t => t.num === L.num + 1);
  const t16 = st.state.project.triggers[15];
  ok(L.edits.chan === 'left' && R?.edits.chan === 'right' && t16.func === 14 && t16.low === L.num && t16.high === L.num + 1, 'split stereo → synced pair', `${L.num}/${R?.num} trig16 ${t16.low}-${t16.high}`);
  st.undo(); st.undo(); // remove split + import

  return results;
}

// Card Doctor diagnosis of a deliberately broken card.
export async function runCard() {
  const card = await import(A + 'views/card.js');
  const files = [
    new File([wavBytes({ ch: 2 })], '0001_good.wav'),
    new File([wavBytes({ ch: 2, extraBefore: 'INFOISFTGarageBand' })], '0002_logic export.wav'),
    new File([wavBytes({ ch: 2, rate: 48000, bits: 24 })], '0003_48k.wav'),
    new File([wavBytes({ ch: 2 })], '3_duplicate.wav'),
    new File([wavBytes({ ch: 2 })], '0010_l2 lowercase flag.wav'),
    new File([wavBytes({ ch: 1 })], '0011_mono in stereo set.wav'),
    new File([wavBytes({ ch: 2 })], 'kick no number.wav'),
    new File(['#TSUS\r\n#TRIG 16, 0, 0, 0, 12, ,\r\n'], 'tsunami.ini'),
  ];
  const r = await card.loadCardFromFiles(files);
  const by = n => r.wavs.find(w => w.name === n);
  const out = [];
  const chk = (c, name) => out.push(`${c ? 'PASS' : 'FAIL'} ${name}`);
  chk(by('0001_good.wav').sev === 'ok', 'good file ok');
  chk(by('0002_logic export.wav').issues.some(i => i.code === 'meta') && by('0002_logic export.wav').repairable, 'metadata flagged + repairable');
  chk(by('0003_48k.wav').sev === 'error' && by('3_duplicate.wav').issues.some(i => /used by 2 files/.test(i.msg)), '48k error + duplicate number 3');
  chk(by('0010_l2 lowercase flag.wav').issues.some(i => /Lower-case/.test(i.msg)), 'lower-case MIDI flag warned');
  chk(by('0011_mono in stereo set.wav').issues.some(i => /Mono file/.test(i.msg)), 'mono file in stereo card flagged');
  chk(by('kick no number.wav').issues.some(i => /ignores/.test(i.msg)), 'unnumbered ignored');
  chk(r.mode === 'stereo' && r.modeFromIni && r.ini.parsed.triggers[0].func === 12, 'ini parsed (stereo, T16 bank up)');
  chk(r.dupes.length === 1, 'one duplicate group');
  return out;
}

// Folder export into the Origin Private File System (same API as a real SD card folder).
export async function runFolderExport() {
  const exp = await import(A + 'export.js');
  const st = await import(A + 'state.js');
  const wav = await import(A + 'wav.js');
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sdtest', { recursive: true }); } catch { /* first run */ }
  const dir = await root.getDirectoryHandle('sdtest', { create: true });
  const out = [];
  const chk = (c, name) => out.push(`${c ? 'PASS' : 'FAIL'} ${name}`);
  const logs = [];
  const r1 = await exp.exportToFolder(dir, l => logs.push(l));
  const names = [];
  for await (const [n] of dir.entries()) names.push(n);
  const planned = exp.planExport(st.state.project).length;
  chk(r1.written === planned && r1.verify.bad.length === 0, `first export writes + verifies ${r1.written}/${planned}`);
  chk(names.includes('tsunami.ini') && names.includes(exp.MANIFEST), 'ini + manifest written');
  const f = await (await dir.getFileHandle(names.find(n => n.startsWith('0001')))).getFile();
  const info = await wav.inspectWav(f);
  chk(info.ok && info.fmt.channels === (st.state.project.mode === 'mono' ? 1 : 2), 'card file is Tsunami-safe: ' + info.chunkSummary);
  st.update(p => { p.tracks.find(t => t.num === 2).edits.gain = -3; }, { reason: 'edit' });
  const r2 = await exp.exportToFolder(dir, l => logs.push(l));
  chk(r2.written === 1 && r2.skipped === planned - 1, `incremental: wrote ${r2.written}, skipped ${r2.skipped}`);
  st.update(p => { p.tracks.find(t => t.num === 2).name = 'Snare renamed'; }, { reason: 'edit' });
  // old 0002_Snare.wav now conflicts with 0002_Snare renamed.wav → modal asks; auto-confirm delete
  setTimeout(() => [...document.querySelectorAll('.modal .btn.danger')].pop()?.click(), 300);
  const r3 = await exp.exportToFolder(dir, l => logs.push(l));
  const after = []; for await (const [n] of dir.entries()) after.push(n);
  chk(r3.deleted === 1 && !after.includes('0002_Snare.wav') && after.includes('0002_Snare renamed.wav'), 'renamed track replaces old same-number file');
  return out;
}

// Bank navigation on T15/T16: numbering skips those slots, stray tracks there are flagged,
// and mono sources come out stereo.
export async function runKits() {
  const st = await import(A + 'state.js');
  const val = await import(A + 'validate.js');
  const audio = await import(A + 'audio.js');
  const out = [];
  const chk = (c, name) => out.push(`${c ? 'PASS' : 'FAIL'} ${name}`);
  const p = st.state.project;
  chk(p.triggers[14].func === 13 && p.triggers[15].func === 12, 'new project: T15 Bank −, T16 Bank +');
  const nums = p.tracks.map(t => t.num).filter(n => n != null).sort((a, b) => a - b);
  chk(!nums.some(n => [15, 16, 31, 32].includes(n)), 'demo kits avoid slots 15/16: ' + nums.slice(0, 16).join(','));
  chk(st.nextFreeNum(14) === 33 || st.nextFreeNum(14) === 14, 'nextFreeNum skips 15/16 → ' + st.nextFreeNum(14));
  const empty = new Map();
  chk(st.nextFreeNum(15, empty) === 17 && st.nextFreeNum(31, empty) === 33, 'free-slot search jumps 15→17, 31→33');
  st.update(pp => { pp.tracks[0].num = 16; }, { reason: 'renumber' });
  chk(st.state.issues.some(i => i.group === 'navslot' && i.sev === 'warn'), 'track on T16 slot is flagged');
  st.undo();
  const t = st.state.project.tracks.find(x => x.info?.channels === 1 && x.num != null);
  const r = await audio.getRendered(t, st.state.project);
  chk(st.state.project.mode === 'stereo' && r.channels.length === 2 && r.channels[0][100] === r.channels[1][100], 'mono source renders as stereo L = R');
  chk(st.state.issues.some(i => i.group === 'upmix' && !i.trackId), 'single mono→stereo note in preflight');
  return out;
}

// Pads: smart kit placement on 1–8, sequential fill on 9+, click audition,
// double-click browse, pan baked into the render, output assignment.
export async function runPads() {
  const st = await import(A + 'state.js');
  const imp = await import(A + 'importer.js');
  const audio = await import(A + 'audio.js');
  const ini = await import(A + 'ini.js');
  const out = [];
  const chk = (c, name) => out.push(`${c ? 'PASS' : 'FAIL'} ${name}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clickModal = label => setTimeout(() => [...document.querySelectorAll('.modal .btn')].find(b => b.textContent === label)?.click(), 400);
  const file = n => new File([wavBytes({ frames: 2000 })], n);
  const at = num => st.state.project.tracks.find(t => t.num === num);

  // kit placement into bank 5 (empty) — names deliberately shuffled
  const bank = 5, base = bank * 16;
  clickModal('Place samples');
  await imp.importToPad(['Ride.wav', 'Tom Hi.wav', 'Clap 1.wav', 'Hat Open.wav', 'Kick Deep.wav', 'Closed Hat.wav', 'Snare Tight.wav', 'Conga.wav', 'Kick Punch.wav', 'Vocal Hey.wav'].map(file), base + 3);
  const got = [1, 2, 3, 4, 5, 6, 7, 8].map(k => at(base + k)?.name);
  chk(JSON.stringify(got) === JSON.stringify(['Kick Deep', 'Snare Tight', 'Hat Open', 'Closed Hat', 'Clap 1', 'Conga', 'Tom Hi', 'Ride']), 'kit placement: ' + got.join(' | '));
  const inbox = st.state.project.tracks.filter(t => t.num == null).map(t => t.name);
  chk(at(base + 17)?.name === 'Kick Punch' && inbox.includes('Vocal Hey'), 'second kick continues on pad 1 of the next bank; unmatched to Inbox');

  // two dropped folders → one bank each (banks 8 and 9)
  const inF = (folder, n) => { const f = file(n); f._folder = folder; return f; };
  clickModal('Place samples');
  await imp.importToPad([inF('Kit 808', 'BD.wav'), inF('Kit 808', 'SD.wav'), inF('Kit 909', 'Kick.wav'), inF('Kit 909', 'Ride.wav'), inF('Kit 909', 'Kick 2.wav')], 8 * 16 + 1);
  chk(at(129)?.name === 'BD' && at(130)?.name === 'SD' && at(145)?.name === 'Kick' && at(152)?.name === 'Ride' && st.state.project.tracks.some(t => t.name === 'Kick 2' && t.num == null), 'one bank per folder: 808 → bank 8, 909 → bank 9');

  // plain file drop goes through the folder scanner untouched
  const dt = new DataTransfer();
  dt.items.add(file('Loose.wav'));
  const scanned = await imp.droppedFiles(dt);
  chk(scanned.length === 1 && scanned[0].name === 'Loose.wav' && scanned[0]._folder === '', 'droppedFiles passes loose files through');

  // pads 9+: name order, stops at pad 14 (15/16 are bank nav), overflow to Inbox
  await imp.importToPad(['c.wav', 'a.wav', 'd.wav', 'b.wav'].map(file), base + 12);
  chk(at(base + 12)?.name === 'a' && at(base + 13)?.name === 'b' && at(base + 14)?.name === 'c' && !at(base + 15) && st.state.project.tracks.some(t => t.name === 'd' && t.num == null), 'pad 12 fill: a,b,c then Inbox');

  // single file on a kit pad goes exactly there, displacing the old one
  await imp.importToPad([file('Big Kick.wav')], base + 1);
  chk(at(base + 1)?.name === 'Big Kick' && st.state.project.tracks.some(t => t.name === 'Kick Deep' && t.num == null), 'single drop replaces pad, old to Inbox');

  // click auditions + selects; second quick click opens the file browser
  const pads = await import(A + 'views/pads.js');
  pads.setBank(bank); st.setView('pads');
  await sleep(300);
  let pickerOpened = 0;
  const realClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === 'file') pickerOpened++; else realClick.call(this); };
  document.querySelector('.pad[data-trig="2"]').click();
  await sleep(250);
  chk(st.state.ui.selectedId === at(base + 2).id && !pickerOpened, 'single click selects pad (and auditions)');
  document.querySelector('.pad[data-trig="2"]').click();
  await sleep(50);
  chk(pickerOpened === 1, 'double click opens the file browser');
  HTMLInputElement.prototype.click = realClick;

  // pan baked into the stereo render
  const t = at(base + 2);
  st.update(p => { p.tracks.find(x => x.id === t.id).edits.pan = -100; }, { reason: 'edit' });
  const r = await audio.getRendered(st.trackById(t.id), st.state.project);
  const peakR = Math.max(...r.channels[1].map(Math.abs)), peakL = Math.max(...r.channels[0].map(Math.abs));
  chk(peakR < 1e-6 && peakL > 0.5, `pan hard left: L ${peakL.toFixed(2)}, R ${peakR.toExponential(1)}`);

  // output assignment via the matrix in the Global drawer
  const g = await import(A + 'views/global.js');
  g.toggleGlobal(true);
  await sleep(300);
  const cell = [...document.querySelectorAll('.omatrix tbody tr')][2].querySelectorAll('.om-cell')[2]; // trigger 3 → pair 3
  cell.click();
  await sleep(300);
  chk(st.state.project.triggers[2].output === 2 && ini.buildIni(st.state.project).includes('#TRIG 03, 80, 0, 2, 1, ,'), 'matrix sets trigger 3 → pair 3 (ini written)');
  g.toggleGlobal(false);
  return out;
}
