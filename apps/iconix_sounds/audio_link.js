'use strict';
/*
 * Sound Drive – Verbindung zum Audio-Dienst (Tool iconix-audiod, läuft als root) über einen Unix-Socket.
 * Probiert werden /run/iconix-audiod/audiod.sock und /tmp/iconix-audiod.sock. Ton macht nur der Dienst: Die App selbst
 * darf die Tonkanäle des Autos nicht öffnen.
 *
 * Protokoll: eine JSON-Nachricht pro Zeile.
 *   App -> Dienst: hello, config {cfg}, params {rpm, load, speed, overrun}, test, diag
 *   Dienst -> App: status {error, backend, playing, underruns, ...}, diag {lines}
 * Zusätzlich schreibt der Dienst /tmp/iconix-audiod.json – daran erkennt die App, ob er überhaupt läuft.
 */
const fs = require('fs');
const net = require('net');
const EventEmitter = require('events');
const Clock = require('./clock');

const SOCKETS = process.env.ICONIX_AUDIOD_SOCKET
  ? [process.env.ICONIX_AUDIOD_SOCKET]
  : ['/run/iconix-audiod/audiod.sock', '/tmp/iconix-audiod.sock'];
const STATUS_FILE = process.env.ICONIX_STATUS_FILE || '/tmp/iconix-audiod.json';
const RECONNECT_MS = 2000;
const SEND_MS = 50;       // 20 Hz Parameter-Updates
const STALE_MS = 1500;    // ältere Fahrzeugdaten nicht senden -> Ton blendet aus
// Motor aus: Das Auto meldet die Drehzahl 0 nur einmal (nur Änderungen). So lange danach weiter als Lebenszeichen
// senden, damit der Dienst den Player bereithält und beim Anlassen sofort Ton kommt (Drehzahl 0 = still).
const OFF_KEEP_MS = 120000;
const WAIT_MS = 5000;     // so lange nach dem Start gilt "verbinde …" statt eines Fehlers

class AudioLink extends EventEmitter {
  constructor(log, appVersion) {
    super();
    this.log = log;
    this.version = appVersion || '0';
    this.sock = null;
    this.connected = false;
    this.rx = '';
    this.cfg = null;
    this.latest = null;
    this.timer = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.pathIndex = 0;
    this.errors = {};        // Pfad -> letzter Fehlercode (ENOENT, EACCES, ECONNREFUSED, ...)
    this.startedAt = Clock.now();
    this.daemonStatus = null;
    this.daemonDiag = null;  // technische Zeilen des Dienstes (nach diagnose())
  }

  connect() {
    if (this.closed || this.sock) return;
    if (!this.timer) this.timer = setInterval(() => this._tick(), SEND_MS);
    const p = SOCKETS[this.pathIndex % SOCKETS.length];
    const s = net.createConnection(p);
    this.sock = s;
    s.setEncoding('utf8');
    s.on('connect', () => {
      this.connected = true;
      this.errors = {};
      this.log.info('iconix: Audio-Dienst verbunden über ' + p);
      this.send({ op: 'hello', id: 'iconix_sounds', version: this.version });
      if (this.cfg) this.send({ op: 'config', cfg: this.cfg });
    });
    s.on('data', chunk => {
      this.rx += chunk;
      let i;
      while ((i = this.rx.indexOf('\n')) >= 0) {
        const line = this.rx.slice(0, i);
        this.rx = this.rx.slice(i + 1);
        if (line) this._onMessage(line);
      }
      if (this.rx.length > 65536) this.rx = '';
    });
    s.on('error', e => { this.errors[p] = (e && e.code) || String(e); });
    s.on('close', () => {
      const was = this.connected;
      this.sock = null;
      this.connected = false;
      this.rx = '';            // halbe Nachricht der alten Verbindung
      if (was) { this.daemonStatus = null; this.log.warn('iconix: Verbindung zum Audio-Dienst verloren'); }
      else this.pathIndex++; // nächsten Pfad probieren
      if (!this.closed && !this.reconnectTimer) {
        // alle Pfade einmal durch, dann Pause
        const delay = (!was && this.pathIndex % SOCKETS.length !== 0) ? 50 : RECONNECT_MS;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
      }
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) this.sock.destroy();
  }

  send(obj) {
    if (!this.sock || !this.connected) return false;
    try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { return false; }
  }

  configure(cfg) { this.cfg = cfg; this.send({ op: 'config', cfg: cfg }); }

  // sofort weitergeben (der Takt unten sendet nur noch Keepalives) – spart im Schnitt ~25 ms Verzögerung
  params(sample) { this.latest = sample; this._tick(); }

  test() { return this.send({ op: 'test' }); }

  /** Technische Zeilen vom Dienst anfordern; sie kommen als Ereignis 'diag'. */
  diagnose() { return this.send({ op: 'diag' }); }

  _tick() {
    const p = this.latest, now = Clock.now();
    if (!p || (now - p.at > STALE_MS && !(p.rpm < 100 && now - p.at < OFF_KEEP_MS))) return;
    const rpm = Math.round(p.rpm), load = Math.round(p.load * 1000) / 1000, speed = Math.round(p.speed * 10) / 10;
    // gerundet senden und Unverändertes nur als Keepalive alle 500 ms
    const key = rpm + '|' + load + '|' + speed + '|' + (p.overrun ? 1 : 0);
    if (key === this.lastKey && now - this.lastSend < 500) return;
    this.lastKey = key; this.lastSend = now;
    this.send({ op: 'params', rpm: rpm, load: load, speed: speed, overrun: p.overrun });
  }

  /** Noch im Aufbau (App gerade gestartet)? */
  waiting() { return !this.connected && Clock.now() - this.startedAt < WAIT_MS; }

  /** Warum ist der Dienst nicht erreichbar? */
  why() {
    const now = Clock.now();
    if (!this.whyAt || now - this.whyAt > 1000) { this.whyAt = now; this.whyText = this._why(); }   // wird bei jedem Bild gefragt
    return this.whyText;
  }
  _why() {
    const codes = SOCKETS.map(p => this.errors[p]).filter(Boolean);
    if (codes.indexOf('EACCES') >= 0 || codes.indexOf('EPERM') >= 0) return 'kein Zugriff auf den Dienst';
    let running = false;
    try {
      const st = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      running = st && Math.abs(Date.now() - (st.at || 0)) < 10000;   // Wanduhr: die Datei schreibt ein anderer Prozess
    } catch (e) { running = false; }
    return running ? 'Dienst läuft, antwortet aber nicht (' + (codes[0] || '?') + ')' : 'Dienst läuft nicht';
  }

  _onMessage(line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.op === 'diag' && Array.isArray(m.lines)) {
      this.daemonDiag = m.lines.map(String);
      // Tonkanäle des Autos ins Log (nur in der Diagnose, je App-Start einmal)
      if (!this.loggedChannels) { this.loggedChannels = true; this.daemonDiag.forEach(x => AudioLink.logLong(this.log, x)); }
      this.emit('diag');
      return;
    }
    if (m.op !== 'status') return;
    // neue Aussetzer ins Log der App (höchstens alle 30 s), damit sie im QR-Log mit Uhrzeit stehen
    const u = m.underruns || 0, now = Clock.now();
    if (u < (this.logDrops || 0)) this.logDrops = u;       // Dienst neu gestartet
    if (u > (this.logDrops || 0) && now - (this.logDropsAt || 0) > 30000) {
      this.log.info('iconix: Aussetzer ' + u + ' (+' + (u - (this.logDrops || 0)) + '; davon Player zu spät ' + (m.xruns || 0) + '), Vorlauf ' + m.leadMs + ' ms, ALSA-Puffer ' + (m.bufMs || '?') + '/' + (m.perMs || '?') +
        ' ms, Echtzeit ' + (m.rt || '?') + ', verspätet ' + (m.late || 0) + ', längste Pause ' + (m.gapMs || 0) + ' ms');
      this.logDrops = u; this.logDropsAt = now;
    }
    this.daemonStatus = m;
  }

  /** Lange Aufzählung (", "-getrennt) in Zeilen unter 230 Zeichen ins Log: Das QR-Log schneidet nach 300 ab. */
  static logLong(log, text) {
    let line = '';
    String(text).split(', ').forEach(x => {
      if (line && line.length + x.length > 220) { log.info('iconix: ' + line + ','); line = '…'; }
      line += (line === '' ? '' : line === '…' ? ' ' : ', ') + x;
    });
    if (line) log.info('iconix: ' + line);
  }

}

module.exports = AudioLink;
module.exports.SOCKETS = SOCKETS;
