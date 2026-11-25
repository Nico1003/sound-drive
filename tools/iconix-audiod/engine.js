'use strict';
/*
 * Sound Drive – Audio-Kern des Dienstes iconix-audiod (nur Node, Node-8-kompatibel)
 *
 * Synthese (synth.js) + Player (alsa_play.py: SmartX-Kanal oder Einmischen in die Musik) + Taktgeber.
 *
 *   const eng = new Engine({ log: fn, onStatus: st => ... });
 *   eng.configure(cfg); eng.params({ rpm, load, speed, overrun }); eng.test(); eng.start(); eng.stop();
 *
 * Umgebungsvariablen: ICONIX_RATE, ICONIX_LEAD_MS, ICONIX_FB_LEAD_MS, ICONIX_SMARTX_BUFFER_US, ICONIX_IDLE_STOP_MS, ICONIX_PYTHON,
 * ICONIX_SHM_DIR (Tests)
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Synth = require('./synth');

// Uhr für Abstände und Fristen: läuft gleichmäßig weiter, auch wenn das Head Unit die Uhrzeit stellt (sonst gälten die
// Fahrdaten bei einem Sprung als veraltet und der Ton setzte kurz aus). Startwert beliebig, aber groß (0 heißt "nie").
const clock = { now: function () { const t = process.hrtime(); return 1e9 + t[0] * 1000 + Math.floor(t[1] / 1e6); } };

// Synthese-Rate: 48 kHz wie die SmartX-Kanäle des Head Units (24-kHz-Kanäle bekommen je 2 Frames gemittelt)
const RATE = Number(process.env.ICONIX_RATE) || 48000;
const TICK_MS = 10;          // 100 Wakeups/s, solange Ton läuft – kleine Blöcke erlauben knappen Vorlauf
const IDLE_TICK_MS = 200;    // ohne Ton nur 5 Wakeups/s; neue Fahrzeugdaten oder Testsound wecken sofort
// so viel Audio liegt höchstens vor (muss > TICK_MS + Jitter des Head Units sein). 160 ms gibt Reserve,
// wenn Node auf dem Head Unit kurz hängt (GC, andere Apps) – sonst knackt/stottert es (Underrun).
const LEAD_MS = Number(process.env.ICONIX_LEAD_MS) || 160;
// Mit Rückmeldung des Players (alsa_play.py meldet gespielte Frames): so viel Ton steht höchstens an
// (ALSA-Puffer + Pipe). Das ist die Verzögerung zwischen Fahrzeugdaten und Lautsprecher.
// Untergrenze 80 ms (siehe FB_LEAD_START für den Start und die Anpassung).
const FB_LEAD_MS = Number(process.env.ICONIX_FB_LEAD_MS) || 80;
const FB_LEAD_MAX = 200;
// Start großzügig (Head Unit beim Hochfahren ausgelastet -> sonst Aussetzer/Quietschen), danach alle 10 s
// ohne Aussetzer 10 ms knapper bis zur Untergrenze; bei einem Aussetzer sofort +30 ms.
// Die Untergrenze merkt sich, wo es zu knapp war (Vorlauf beim Aussetzer + 20 ms): Früher ging es nach jedem Aussetzer
// wieder bis 60 ms hinunter – bis zum nächsten, also rund alle 30 s einer (62 in 33 min). Sie sinkt nur alle
// FB_FLOOR_MS ohne Aussetzer um 10 ms.
// Dazu zählt auch die längste Pause zwischen zwei Takten: Im Auto waren es kurz nach dem Start 87 ms – mit 100 ms Vorlauf
// beim Start ergab das drei Aussetzer, bevor der Regler reagierte (Knarzen am Anfang).
const FB_LEAD_START = 160;
const FB_GAP_MS = 45;        // so viel Reserve über der längsten gemessenen Pause
const FB_FLOOR_MS = 600000;
const STALE_MS = 1500;       // ohne Daten -> ausblenden
const IDLE_STOP_MS = Number(process.env.ICONIX_IDLE_STOP_MS) || 30000;  // so lange still -> Abspielprogramm beenden (gibt das Audiogerät frei); kurz = Neustart bei jedem Halt
const MAX_CHUNK = 4096;
// SmartX: Puffer des Kanals. Zählt zum Vorlauf (kein zusätzlicher Verzug), gibt dem Player aber Luft; nimmt der Kanal
// ihn nicht, gilt der kleinere (alsa_play.py)
const SMARTX_BUFFER_US = Number(process.env.ICONIX_SMARTX_BUFFER_US) || 60000;
// Mischen in den Musikstrom: Der Motorsound kommt mit 24 kHz Stereo (halbe Rechenzeit), alsa_play.py macht 48 kHz daraus
const MIX_RATE = 24000;
const MIX_POLL_MS = 40, MIX_FIND_MS = 1000, MIX_ALIVE_MS = 400;   // Musikstrom beobachten: Takt, Suche, gilt so lange als laufend
const SMARTX_RETRY_MS = 3000; // SmartX-Kanal ließ sich nicht öffnen -> so oft erneut probieren

// ---------------------------------------------------------------------------
// Player: alsa_play.py (Python + ctypes; das Head Unit hat libasound und mgu-python, aber kein aplay)
// ---------------------------------------------------------------------------
function findBin(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin']);
  for (let i = 0; i < dirs.length; i++) {
    if (!dirs[i]) continue;
    const p = path.join(dirs[i], bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* weiter */ }
  }
  return null;
}

// Python finden: PATH, dann die Store-Tools unter /var/opt (mgu-python bringt Python 3.12 mit)
let pythonCache;
function findPython() {
  // nur einen Treffer merken: beim Hochfahren kann Python noch fehlen, dann beim nächsten Versuch wieder suchen
  if (pythonCache) return pythonCache;
  if (process.env.ICONIX_PYTHON) { pythonCache = process.env.ICONIX_PYTHON; return pythonCache; }
  const names = ['python3', 'python3.12', 'python'];
  for (let i = 0; i < names.length; i++) { const p = findBin(names[i]); if (p) { pythonCache = p; return p; } }
  const rels = ['current/bin/python3', 'current/bin/python3.12', 'current/python3', 'current/python/bin/python3',
    'current/usr/bin/python3', 'bin/python3'];
  let dirs = [];
  try { dirs = fs.readdirSync('/var/opt'); } catch (e) { dirs = []; }
  dirs.sort(function (a, b) { return (/python/.test(b) ? 1 : 0) - (/python/.test(a) ? 1 : 0); });
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < rels.length; j++) {
      const p = path.join('/var/opt', dirs[i], rels[j]);
      try { fs.accessSync(p, fs.constants.X_OK); pythonCache = p; return p; } catch (e) { /* weiter */ }
    }
  }
  return null;
}

const ALSA_SCRIPT = path.join(__dirname, 'alsa_play.py');

// ---------------------------------------------------------------------------
// SmartX-Kanäle (Intel IAS SmartXbar): jeder Kanal hat in /dev/shm "smartx_<Kanal>_p_connection".
// Geschrieben wird über ALSA "plug:smartx:<Kanal>"; hörbar erst, wenn der Audiomanager die Quelle verbindet
// (macht die App, car_route.js). Format steht im Namen: _CF_24_ = 24 kHz, MONO = 1 Kanal.
// ---------------------------------------------------------------------------
function smartxEndpoints() {
  let names = [];
  try { names = fs.readdirSync('/dev/shm'); } catch (e) { names = []; }
  const out = [];
  names.forEach(function (n) {
    const m = /^smartx_(.+)_p_connection$/.exec(n);
    if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
  });
  return out.sort();
}
/** Musikstrom eines SmartX-Kanals ("mix:<Kanal>"): Der Motorsound wird dort hineingemischt (alsa_play.py mix). */
function isMix(d) { return /^mix:/.test(d || ''); }
function isSmartx(d) { return /(^|:)smartx:/.test(d || '') || isMix(d); }
/** "smartx:<Name>" -> "plug:smartx:<Kanal>" (exakter Kanal oder erster, der mit <Name>_ beginnt). */
function resolveSmartx(d, list) {
  if (!/^smartx:/.test(d || '')) return d;
  const want = d.slice(7);
  list = list || smartxEndpoints();
  let hit = list.indexOf(want) >= 0 ? want : null;
  if (!hit) {
    const base = want.replace(/_CF_\d+.*$/, '');
    hit = list.filter(function (n) { return n.indexOf(base + '_') === 0 || n === base; })[0] || null;
  }
  if (!hit) hit = /_CF_\d+/.test(want) ? want : want + '_CF_48_STEREO'; // unbekannt: so probieren
  return 'plug:smartx:' + hit;
}
/** Ausgabeformat eines Geräts: SmartX-Kanäle nach Namen, sonst Synthese-Rate Stereo. */
function formatOf(dev) {
  if (isMix(dev)) return { rate: MIX_RATE, ch: 2 };
  const m = /smartx:.*_CF_(\d+)/.exec(dev || '');
  const k = m ? Number(m[1]) : 0;
  const rate = k === 24 ? 24000 : (k === 16 ? 16000 : RATE);
  return { rate: rate, ch: /smartx:.*MONO/i.test(dev || '') ? 1 : 2 };
}

/**
 * Beobachtet (nur lesend), ob in einem SmartX-Kanal gerade Musik läuft: Schreibposition im Ringpuffer
 * /dev/shm/smartx_<Kanal>_p_ringbuffer. Aufbau und Prüfung wie in alsa_play.py (class Ring).
 */
function MixProbe(channel) {
  this.channel = channel;
  this.path = path.join(process.env.ICONIX_SHM_DIR || '/dev/shm', 'smartx_' + channel + '_p_ringbuffer');
  this.fd = null; this.off = 0; this.ino = 0; this.findAt = 0; this.err = null; this.info = null;
  this.pos = null; this.movedAt = 0; this.buf = Buffer.alloc(48);
}
/** Kopf des Ringpuffers an Stelle o, oder null, wenn dort etwas nicht zusammenpasst. */
MixProbe.head = function (b, o, size) {
  const u = function (i) { return b.readUInt32LE(o + i * 4); };
  const per = u(0), num = u(1), ch = u(2), r = u(4), w = u(5), fmt = u(6), ss = u(7), lvl = u(8);
  if (!(per >= 16 && per <= 16384 && num >= 2 && num <= 256 && ch >= 1 && ch <= 32 && u(3) <= 64 && fmt >= 1 && fmt <= 3)) return null;
  if (ss !== (fmt === 2 ? 2 : 4) || b[o + 36] !== 1 || b[o + 37] !== 1 || b[o + 38] > 1 || b[o + 39] > 1) return null;
  const n = per * num;
  if (r >= n || w >= n || lvl > n) return null;
  const hi = b.readInt32LE(o + 44), base = o + 40 + hi * 4294967296 + b.readUInt32LE(o + 40);
  if (!(base > 0 && base % 4 === 0 && base + n * ch * ss <= size)) return null;
  return { per: per, num: num, ch: ch, fmt: ['', 'f32', 's16', 's32'][fmt], w: w, lvl: lvl };
};
MixProbe.prototype._close = function () { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* egal */ } } this.fd = null; this.pos = null; this.info = null; };
MixProbe.prototype._find = function () {
  let fd = null;
  try {
    const st = fs.statSync(this.path);
    if (this.fd !== null) { if (st.ino === this.ino) return; this._close(); }
    if (st.size < 1024 || st.size > 1 << 24) { this.err = 'Größe ' + st.size; return; }
    fd = fs.openSync(this.path, 'r');
    const all = Buffer.alloc(st.size), n = fs.readSync(fd, all, 0, st.size, 0);
    if (all.indexOf('_ringBufferReal') < 0) { this.err = 'Aufbau unbekannt (Name fehlt)'; fs.closeSync(fd); return; }
    let hits = 0;
    for (let o = 0; o + 48 <= n; o += 8) {
      if (all[o + 36] !== 1 || all[o + 37] !== 1) continue;
      const h = MixProbe.head(all, o, st.size);
      if (h) { hits++; this.off = o; this.info = h; }
    }
    if (hits !== 1) { this.err = 'Aufbau unbekannt (' + hits + ' Treffer)'; this.info = null; fs.closeSync(fd); return; }
    this.fd = fd; this.ino = st.ino; this.size = st.size; this.err = null; this.pos = null;
  } catch (e) {
    this.err = e.code || e.message;
    if (fd !== null && this.fd !== fd) { try { fs.closeSync(fd); } catch (x) { /* egal */ } }
    this._close();
  }
};
MixProbe.prototype.poll = function (now) {
  if (now - this.findAt >= MIX_FIND_MS) { this.findAt = now; this._find(); }
  if (this.fd === null) return;
  try {
    if (fs.readSync(this.fd, this.buf, 0, 48, this.off) !== 48) return;
    const w = this.buf.readUInt32LE(20);
    if (this.pos !== null && w !== this.pos) this.movedAt = now;
    this.pos = w;
  } catch (e) { this.err = e.code || e.message; this._close(); }
};
MixProbe.prototype.state = function (now) {
  const i = this.info;
  return { alive: this.fd !== null && this.movedAt > 0 && now - this.movedAt < MIX_ALIVE_MS, err: this.err,
    ring: i ? i.num + 'x' + i.per + ' ' + i.ch + 'ch ' + i.fmt : null };
};

/** Aufruf des Players für ein Gerät (SmartX-Kanal oder "mix:<Kanal>"), oder null: kein Python oder kein solches Gerät. */
function playerFor(device) {
  const py = findPython();
  if (!isSmartx(device) || !py || !fs.existsSync(ALSA_SCRIPT)) return null;
  const f = formatOf(device);
  return { name: isMix(device) ? device : 'alsa:' + device, path: py, fmt: f,
    argv: isMix(device) ? [ALSA_SCRIPT, 'mix', device.slice(4), String(MIX_RATE)] : [ALSA_SCRIPT, 'play', device, String(f.rate), String(SMARTX_BUFFER_US), String(f.ch)] };
}

// ---------------------------------------------------------------------------
// PCM-Ausgabe über den Player (Kindprozess)
// ---------------------------------------------------------------------------
function Output(onState, log, opts) {
  this.onState = onState || function () {};
  this.log = log || function () {};
  this.opts = opts || {};
  this.child = null;
  this.backend = null;
  this.blocked = false;
  this.underruns = 0; this.xruns = 0; this.perMs = null;
  this.error = null;
  this.lastErr = '';
  this.fmt = { rate: RATE, ch: 2 };
  this.played = null;
  this.sent = 0; this.opened = false; this.openMs = null;
}

Output.prototype.start = function () {
  if (this.child) return true;
  const self = this, log = this.log;
  const b = playerFor(this.opts.device);
  if (!b) {
    this.error = 'Python (mgu-python) oder alsa_play.py fehlt';
    this.onState();
    return false;
  }
  log('starte ' + b.name + ' ' + b.path + ' ' + b.argv.join(' '));
  let child;
  try {
    // der vierte Kanal (fd 3) trägt den Ausgangspegel
    child = cp.spawn(b.path, b.argv, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { ICONIX_CTL: '1' }) });
  } catch (e) {
    this.error = 'Player startet nicht: ' + e.message; this.onState();
    return false;
  }
  const startedAt = clock.now();
  this.child = child;
  this.backend = b.name;
  this.fmt = b.fmt;
  this.blocked = false;
  this.error = null;
  // gespielte Frames (Ausgaberate) laut Player; null = Player meldet nichts -> Takt nach Uhr
  this.played = 0;
  this.startedAt = startedAt; this.gotPos = false;
  // Das erste Öffnen eines SmartX-Kanals nach dem Hochfahren kann lange dauern (andere maßen bis 52 s)
  this.opened = false; this.openMs = null; this.sent = 0;
  let rest = '';
  child.stdout.setEncoding('ascii');
  child.stdout.on('data', function (d) {
    if (self.child !== child) return;
    const lines = (rest + d).split('\n'); rest = lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].charAt(0) === 'P') { const v = Number(lines[i].slice(2)); if (isFinite(v)) { self.played = v; self.gotPos = true; self._open(); break; } }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (d) {
    const line = String(d).trim().split('\n').pop();
    if (!line) return;
    // Aussetzer zählen statt als Fehler werten
    if (/underrun|xrun/i.test(line)) {
      self.underruns++;
      if (!/Stille nachgelegt/.test(line)) self.xruns++;   // Puffer der Soundkarte leer (Player kam zu spät), sonst fehlte Nachschub
      if (self.underruns <= 5 || self.underruns % 50 === 0) log(b.name + ': ' + line + ' (#' + self.underruns + ')');
      return;
    }
    const mb = /Puffer (\d+) ms/.exec(line);
    if (mb) { if (self.child === child) self._open(); const mp = /Periode (\d+) ms/.exec(line); self.perMs = mp ? Number(mp[1]) : null; self.bufMs = Number(mb[1]); const mr = /Echtzeit (.*)$/.exec(line); self.rt = mr ? mr[1] : null; log(b.name + ': ' + line); return; }
    self.lastErr = line.slice(0, 120); log(b.name + ': ' + line);
  });
  this.ctl = child.stdio[3]; this.ctlDb = 0;
  this.ctl.on('error', function () { /* egal */ });
  child.stdin.on('error', function () { /* EPIPE -> exit folgt */ });
  child.stdin.on('drain', function () { self.blocked = false; });
  // ließ sich das Programm gar nicht starten, kommt nur 'error' und kein 'exit' – sonst gälte es für immer als laufend
  child.on('error', function (e) { self.lastErr = e.message; if (!child.pid) gone('-', e.code || e.message); });
  child.on('exit', gone);
  function gone(code, sig) {
    log(b.name + ' beendet, code ' + code + ' signal ' + sig);
    if (self.child === child) {
      self.child = null;
      self.backend = null;
      if (!self.stopping && clock.now() - startedAt < 3000) {
        self.error = b.name + ' fehlgeschlagen' + (self.lastErr ? ': ' + self.lastErr : '');
      }
      self.stopping = false;
      self.onState();
    }
  }
  this.onState();
  return true;
};

/** Kanal ist offen: merken, wie lange es gedauert hat. */
Output.prototype._open = function () {
  if (this.opened) return;
  this.opened = true; this.openedAt = clock.now(); this.openMs = this.openedAt - this.startedAt;
  if (this.openMs > 3000) this.log(this.backend + ': Kanal öffnete erst nach ' + this.openMs + ' ms');
  this.onState();
};

/** Player beenden. next: gleich folgt ein anderer (Wechsel des Tonwegs) – der Dienst behält seine Echtzeit-Priorität. */
Output.prototype.stop = function (next) {
  if (!this.child || this.stopping) return;
  this.stopping = true;
  if (next) { try { this.ctl.write('K\n'); } catch (e) { /* egal */ } }
  try { this.child.stdin.end(); } catch (e) { /* egal */ }
  const c = this.child;
  setTimeout(function () { try { c.kill('SIGTERM'); } catch (e) { /* egal */ } }, 300);
};

/** Ausgangspegel (dB) an den Player geben: gleicht den Lautstärkeknopf des Autos aus (cfg.outDb). */
Output.prototype.level = function (db) {
  if (!this.child || !this.ctl || db === this.ctlDb) return;
  this.ctlDb = db;
  try { this.ctl.write('G ' + Math.pow(10, db / 20).toFixed(5) + '\n'); } catch (e) { /* egal */ }
};

/** Frames (in Synthese-Rate), die zusammen ein Ausgabe-Frame ergeben (2 bei 24-kHz-Kanälen). */
Output.prototype.step = function () { return Math.max(1, Math.round(RATE / (this.fmt.rate || RATE))); };

Output.prototype.write = function (buf) {
  if (!this.child || this.blocked) return false;
  this.sent += buf.length / (2 * (this.fmt.ch === 1 ? 1 : 2));   // Frames in Ausgaberate, seit dem Start dieses Players
  const ok = this.child.stdin.write(buf);
  if (!ok) this.blocked = true;
  return true;
};

// Im Musikstrom ist die Musik bis an die Grenze ausgesteuert: Motorsound dort etwas leiser ansetzen
const MIX_BASE = 0.7;
/**
 * Float32 Stereo -> S16LE (ch 1: beide Seiten gemittelt), gain: fester Pegel. Int16Array-Sicht statt writeInt16LE: Das Head Unit
 * ist little-endian, und Buffer.alloc liefert immer byteOffset 0.
 */
function toPcm(f32, frames, ch, gain) {
  const g = gain || 1, n = ch === 1 ? frames : frames * 2, buf = Buffer.alloc(n * 2);
  const out = new Int16Array(buf.buffer, buf.byteOffset, n);
  for (let i = 0; i < n; i++) {
    const v = (ch === 1 ? (f32[2 * i] + f32[2 * i + 1]) * 0.5 : f32[i]) * g;
    out[i] = v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0);
  }
  return buf;
}

// Test-Sweep: Leerlauf -> Vollgas bis Abregeldrehzahl -> Schub -> Teillast
function sweepAt(t, cfg) {
  const idle = cfg.carIdle || 800, red = cfg.carRedline || 4800;
  if (t < 0.8) return { rpm: idle, load: 0.05, speed: 0, overrun: false };
  if (t < 4.0) { const x = (t - 0.8) / 3.2; return { rpm: idle + (red - idle) * x, load: 1, speed: 120 * x, overrun: false }; }
  if (t < 5.5) { const x = (t - 4.0) / 1.5; return { rpm: red - (red - 1500) * x, load: 0, speed: 120 - 20 * x, overrun: true }; }
  if (t < 7.5) { const x = (t - 5.5) / 2; return { rpm: 1500 + 2000 * x, load: 0.5, speed: 100 + 20 * x, overrun: false }; }
  const x = Math.min(1, (t - 7.5) / 1.5);
  return { rpm: 3500 - (3500 - idle) * x, load: 0, speed: 120 * (1 - x), overrun: x < 0.9 };
}

// ---------------------------------------------------------------------------
// Engine: Synth + Ausgabe + Taktgeber
// ---------------------------------------------------------------------------
function Engine(opts) {
  opts = opts || {};
  const self = this;
  this.log = opts.log || function () {};
  this.onStatus = opts.onStatus || function () {};
  this.synth = new Synth(RATE);
  this.device = null;     // Tonweg, kommt mit den Einstellungen der App ("smartx:<Name>" oder "mix:<Kanal>")
  this.out = new Output(function () { self._changed(); }, this.log, {});
  this.wantSound = false; this.lastRetry = 0;
  this.lastParams = 0;
  this.testUntil = 0; this.testStart = 0;
  this.silentSince = 0;
  this.t0 = 0; this.written = 0;
  this.lastTick = clock.now(); this.late = 0; this.gapMs = 0;   // verspätete Takte, längste Pause zwischen zwei Takten
  this.fbFloor = FB_LEAD_MS; this.fbFloorAt = 0;
  this.f32 = new Float32Array(MAX_CHUNK * 2);
  this.timer = null;
  this.outDb = 0;
  this.warm = null; this.warmLeft = 60;        // Synthese warmlaufen lassen, bevor der erste Ton gebraucht wird
  this.probes = []; this.probeTimer = null; this.probeKey = '';
}

/** Musikströme beobachten (Namen der Kanäle; leer = keine). */
Engine.prototype.setProbes = function (names) {
  const self = this, list = Array.isArray(names) ? names.filter(function (n) { return /^[A-Za-z0-9_]{1,80}$/.test(n); }).slice(0, 4) : [];
  if (list.join() === this.probes.map(function (p) { return p.channel; }).join()) return;
  this.probes.forEach(function (p) { p._close(); });
  if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null; }
  this.probes = list.map(function (n) { return new MixProbe(n); });
  if (!list.length) return;
  let next = 0;
  this.probeTimer = setInterval(function () {
    const now = clock.now();
    if (now < next) return;
    self.probes.forEach(function (p) { p.poll(now); });
    // kein Kanal da: nur einmal je Sekunde nachsehen
    next = self.probes.some(function (p) { return p.fd !== null; }) ? 0 : now + MIX_FIND_MS;
    const key = JSON.stringify(self.mixState(now));
    if (key !== self.probeKey) { self.probeKey = key; self._changed(); }
  }, MIX_POLL_MS);
  if (this.probeTimer.unref) this.probeTimer.unref();
};
Engine.prototype.mixState = function (now) {
  if (!this.probes.length) return null;
  const out = {};
  this.probes.forEach(function (p) { out[p.channel] = p.state(now); });
  return out;
};

Engine.prototype.configure = function (cfg) {
  this.synth.configure(cfg);
  // Testsound hat "Stumm" kurz aufgehoben, und jetzt schaltet jemand den Ton an: nach dem Test nicht wieder stumm
  if (this._testUnmuted && this.synth.cfg.enabled) this._testUnmuted = false;
  if (cfg && 'outDb' in cfg) { this.outDb = isFinite(+cfg.outDb) ? Math.max(-40, Math.min(15, +cfg.outDb)) : 0; this.out.level(this.outDb); }
  if (cfg && 'steady' in cfg) this.steady = !!cfg.steady;
  if (cfg && 'mixProbe' in cfg) this.setProbes(cfg.mixProbe);
  if (cfg && cfg.device && cfg.device !== this.device) this.setDevice(cfg.device);
  this._changed();
};

Engine.prototype.setDevice = function (d) {
  const self = this, old = this.out;
  this.device = d;
  this.out = new Output(function () { self._changed(); }, this.log, { device: resolveSmartx(d) });
  this.out.underruns = old.underruns; this.out.xruns = old.xruns;
  old.stop(true);
  this.log('Ausgabe: ' + d + ' -> ' + this.out.opts.device);
  this._changed();
};

Engine.prototype.params = function (p) { this.synth.setParams(p); this.lastParams = clock.now(); this.wake(); };
Engine.prototype.test = function () {
  this.testStart = clock.now(); this.testUntil = this.testStart + 9000;
  this.out.error = null;      // nach einem Fehler sofort erneut probieren
  this._changed();
  this.wake();
};

Engine.prototype.status = function () {
  const out = this.out;
  return {
    ok: !out.error,
    playing: !!out.child && out.opened !== false, opening: !!out.child && out.opened === false, openMs: out.openMs, error: out.error, profile: this.synth.pending || this.synth.cfg.profile,
    underruns: out.underruns || 0, xruns: out.xruns || 0, perMs: out.child ? out.perMs : null, late: this.late, gapMs: this.gapMs, bufMs: out.child ? out.bufMs || null : null, rt: out.child ? out.rt || null : null, ducked: !!this.synth.cfg.duck, leadMs: out.played != null && out.child ? (this.fbLead || FB_LEAD_MS) : LEAD_MS,
    device: this.device,
    mix: this.mixState(clock.now()),
    wants: !!this.wantSound, outRate: out.fmt.rate
  };
};

Engine.prototype._changed = function () { try { this.onStatus(this.status()); } catch (e) { /* egal */ } };

Engine.prototype.start = function () {
  if (this.timer || this.running) return;
  this.running = true;
  this.lastTick = clock.now();
  this._loop();
};

// Taktgeber: 10 ms, solange Ton läuft oder gewünscht ist, sonst 200 ms (spart im Stand/ohne Daten fast alles)
Engine.prototype._busy = function () {
  return !!(this.out.child || this.wantSound || this.steady || clock.now() < this.testUntil);
};
Engine.prototype._loop = function () {
  const self = this;
  this.timer = null;
  if (!this.running) return;
  this._tick();
  if (this.warmLeft > 0 && !this.out.child) this._warm();
  this.timer = setTimeout(function () { self._loop(); }, this._busy() ? TICK_MS : IDLE_TICK_MS);
};
/**
 * Warmlaufen: Die ersten Blöcke rechnet Node noch unübersetzt, auf dem Head Unit viel langsamer als später – der Ton
 * stockte dadurch in der ersten Sekunde. Darum vorab in kleinen Stücken ins Leere rechnen (24 kHz wie im Auto).
 */
Engine.prototype._warm = function () {
  if (!this.warm) this.warm = new Synth(RATE % MIX_RATE === 0 ? MIX_RATE : RATE);
  for (let i = 0; i < 3 && this.warmLeft > 0; i++, this.warmLeft--) {
    const t = (60 - this.warmLeft) * 0.15;
    this.warm.configure(Object.assign({}, this.synth.cfg, { enabled: true, duck: false, hold: false }));
    this.warm.setParams(sweepAt(t, this.synth.cfg)); this.warm.stale = false;
    this.warm.render(this.f32, 240);
  }
  if (!this.warmLeft) this.warm = null;
};
/** Sofort einen Takt auslösen, wenn der Taktgeber gerade im langsamen Modus ist. */
Engine.prototype.wake = function () {
  if (!this.running || this._busy()) return;
  if (this.timer) clearTimeout(this.timer);
  this._loop();
};

Engine.prototype.stop = function () {
  this.running = false;
  this.setProbes([]);
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this.out.stop();
};

Engine.prototype._tick = function () {
  const now = clock.now(), synth = this.synth, out = this.out;
  // zählt Wakeups, die so spät kamen, dass der Vorlauf aufgebraucht war
  const gap = out.child && this.ticking ? now - this.lastTick : 0;
  this.gapMs = Math.max(this.gapMs, gap);
  this.ticking = !!out.child;
  if (out.child && now - this.lastTick > (out.played != null ? (this.fbLead || FB_LEAD_START) : LEAD_MS)) this.late++;
  this.lastTick = now;
  const testing = now < this.testUntil || this.steady;
  if (testing) {
    // Abgleich: gleichmäßiger Ton zum Vergleichen, sonst Testfahrt
    synth.setParams(this.steady ? { rpm: 2200, load: 0.5, speed: 0, overrun: false } : sweepAt((now - this.testStart) / 1000, synth.cfg));
    synth.stale = false;
  } else {
    synth.stale = now - this.lastParams > STALE_MS;
  }
  // Testsound auch bei "Stumm" hörbar machen
  const wantSound = (synth.cfg.enabled || testing) && (!synth.stale || testing);
  if (testing && !synth.cfg.enabled) { synth.cfg.enabled = true; this._testUnmuted = true; }
  if (!testing && this._testUnmuted) { synth.cfg.enabled = false; this._testUnmuted = false; }

  this.wantSound = wantSound;
  if (wantSound) this.silentSince = 0;
  else if (!this.silentSince) this.silentSince = now;

  // Kanal ließ sich nicht öffnen (z. B. noch nicht da): regelmäßig neu auflösen und erneut probieren
  if (wantSound && !out.child && out.error && now - this.lastRetry > SMARTX_RETRY_MS) {
    this.lastRetry = now;
    if (resolveSmartx(this.device) !== out.opts.device) { this.setDevice(this.device); return; }
    out.error = null;
  }
  if (wantSound && !out.child && !out.error && out.opts.device) {
    if (out.start()) { this.t0 = now; this.written = 0; }
  }
  if (out.child && !out.stopping && this.silentSince && now - this.silentSince > IDLE_STOP_MS && synth.gain < 0.001) {
    this.log('still – gebe Audiogerät frei');
    out.stop();
  }
  if (!out.child || out.stopping) return;

  const step = out.step();
  let due;
  // Player meldet 1,5 s nach dem Öffnen noch nichts (alte alsa_play.py?) -> zurück zum Takt nach Uhr statt still zu
  // bleiben. Nicht, solange er den Kanal noch öffnet: Sonst liefe die Pipe voll (über 1 s Ton) und alles käme danach
  // dauerhaft verspätet.
  if (out.played === 0 && !out.gotPos && out.opened !== false && out.startedAt && now - (out.openedAt || out.startedAt) > 1500) {
    out.played = null; this.t0 = now; this.written = 0;
    this.log(out.backend + ': keine Rückmeldung vom Player – Takt nach Uhr');
  }
  if (out.played != null) {
    // Regelkreis: nur nachschreiben, was bis zum Ziel-Vorlauf fehlt (geschrieben − gespielt = was ansteht)
    // Vorlauf anpassen: Aussetzer -> mehr Reserve, lange keine -> wieder knapper
    if (this.fbLead == null) { this.fbLead = Math.max(FB_LEAD_MS, FB_LEAD_START); this.fbUnder = out.underruns || 0; this.fbCalm = now; }
    // lange Pause zwischen zwei Takten: Reserve schaffen, bevor sie beim nächsten Mal zum Aussetzer wird
    // (länger als der größte Vorlauf: ließe sich ohnehin nicht überbrücken)
    if (gap <= FB_LEAD_MAX && gap + FB_GAP_MS > this.fbFloor && this.fbFloor < FB_LEAD_MAX) {
      this.fbFloor = Math.min(FB_LEAD_MAX, gap + FB_GAP_MS); this.fbFloorAt = now;
      if (this.fbLead < this.fbFloor) this.fbLead = this.fbFloor;
    }
    // beim Mischen hilft mehr Vorlauf nicht gegen einen zu späten Player (nur die Musik gibt dort den Takt vor)
    const under = (out.underruns || 0) - (isMix(out.opts.device) ? out.xruns || 0 : 0);
    if (under < this.fbUnder) this.fbUnder = under;
    if (under > this.fbUnder) {
      this.fbUnder = under; this.fbCalm = now;
      this.fbFloor = Math.min(FB_LEAD_MAX, Math.max(this.fbFloor, this.fbLead + 20)); this.fbFloorAt = now;
      if (this.fbLead < FB_LEAD_MAX) { this.fbLead = Math.min(FB_LEAD_MAX, this.fbLead + 30); this.log('Aussetzer – Vorlauf jetzt ' + this.fbLead + ' ms'); }
    } else {
      if (this.fbFloor > FB_LEAD_MS && now - this.fbFloorAt > FB_FLOOR_MS) { this.fbFloor = Math.max(FB_LEAD_MS, this.fbFloor - 10); this.fbFloorAt = now; }
      if (now - this.fbCalm > 10000 && this.fbLead > this.fbFloor) { this.fbLead = Math.max(this.fbFloor, this.fbLead - 10); this.fbCalm = now; }
    }
    // Was ansteht: alles, was dieser Player je bekam (out.sent, wird nie zurückgesetzt), minus was er gespielt hat.
    // Nie negativ (Rundung): sonst schriebe der Dienst über den Vorlauf hinaus vor – mehr Verzögerung.
    const queued = Math.max(0, (out.sent != null ? out.sent : this.written / step) - out.played);
    due = Math.floor((this.fbLead / 1000 * RATE / step - queued)) * step;
  } else {
    due = Math.floor((now - this.t0 + LEAD_MS) / 1000 * RATE) - this.written;
    if (due > RATE / 2) { this.t0 = now; this.written = 0; due = Math.floor(LEAD_MS / 1000 * RATE); } // Resync nach Hänger
  }
  // Synthese direkt in der Rate des Kanals (24 kHz: halbe Rechenzeit, kein Umrechnen)
  if (synth.sr !== RATE / step) this._rebuildSynth(RATE / step);
  out.level(this.outDb);
  const gain = isMix(out.opts.device) ? MIX_BASE : 1;
  while (due >= step && !out.blocked && out.child) {
    let n = Math.min(due, MAX_CHUNK);
    n -= n % step;
    this.synth.render(this.f32, n / step);
    out.write(toPcm(this.f32, n / step, out.fmt.ch, gain));
    this.written += n; due -= n;
  }
};

/** Synth mit anderer Abtastrate neu anlegen; Einstellungen und Fahrzeugdaten bleiben erhalten. */
Engine.prototype._rebuildSynth = function (rate) {
  const old = this.synth, s = new Synth(rate);
  s.configure(Object.assign({}, old.cfg));
  // ein angefordertes, noch nicht übernommenes Profil (pending) gilt – sonst spielte nach dem Start das alte weiter
  s._setProfile(old.pending || old.cfg.profile); s._reset();
  s.target = Object.assign({}, old.target); s.stale = old.stale;
  // Motorstart gerade erkannt, während der Player startet: Startsound nicht verlieren
  s.offTime = old.offTime; s.startT = old.startT;
  this.synth = s;
  this.log('Synthese mit ' + rate + ' Hz');
};

// ---------------------------------------------------------------------------
// Technische Diagnose (in einem eigenen Prozess, siehe iconix-audiod.js --diag-json)
// ---------------------------------------------------------------------------
/** Ringpuffer aller SmartX-/AVB-Kanäle (alsa_play.py rings, nur lesend, ~1 s) – nur im Diagnose-Prozess aufrufen. */
function rings() {
  const py = findPython();
  if (!py || !fs.existsSync(ALSA_SCRIPT)) return { rings: [], error: 'kein Python' };
  const p = cp.spawnSync(py, [ALSA_SCRIPT, 'rings'], { timeout: 8000, maxBuffer: 1 << 20, encoding: 'utf8' });
  try { return JSON.parse(String(p.stdout).trim().split('\n').pop()); } catch (e) { return { rings: [], error: String(p.stderr || (p.error && p.error.message) || 'keine Antwort').trim().slice(-120) }; }
}
function ringLine(r) {
  const l = (r && r.rings) || [];
  return 'Ringpuffer ' + (l.map(function (x) {
    return (x.bar === 'avb' ? 'avb:' : '') + x.name + ' ' + (x.error ? x.error.replace(/, /g, ' ') : x.periods + 'x' + x.period + ' ' + x.ch + 'ch ' + x.fmt + (x.alive ? ' LÄUFT ' + x.min + '-' + x.max : ''));
  }).join(', ') || 'keine' + (r && r.error ? ' (' + r.error + ')' : ''));
}

module.exports = {
  clock: clock,
  Engine: Engine, Output: Output, playerFor: playerFor, toPcm: toPcm, sweepAt: sweepAt, MIX_BASE: MIX_BASE, MixProbe: MixProbe, isMix: isMix, rings: rings, ringLine: ringLine,
  smartxEndpoints: smartxEndpoints, resolveSmartx: resolveSmartx, formatOf: formatOf, isSmartx: isSmartx,
  FB_LEAD_MS: FB_LEAD_MS, FB_LEAD_START: FB_LEAD_START
};
