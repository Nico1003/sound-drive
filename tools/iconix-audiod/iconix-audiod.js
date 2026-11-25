'use strict';
/*
 * iconix-audiod – Audio-Dienst für Sound Drive (EXPERIMENTELL)
 *
 * Läuft als systemd-Dienst (Root-Tool des mgu-store) auf dem Head Unit mit dessen Node 8.
 * Empfängt von der App über Unix-Sockets Drehzahl/Last/Tempo und Einstellungen und gibt den Sound
 * über engine.js aus (Synthese + alsa_play.py).
 *
 * Erreichbarkeit für die App (die ohne Root läuft):
 *   - Sockets: /run/iconix-audiod/audiod.sock (systemd RuntimeDirectory) und /tmp/iconix-audiod.sock
 *     (/tmp ist auf dem Head Unit ein gemeinsames tmpfs aller Prozesse – das Kit legt dort seine Frames ab)
 *   - Statusdatei /tmp/iconix-audiod.json (alle 2 s), damit die App auch ohne Socket sieht, dass der Dienst läuft
 *
 * Kommandozeile:
 *   node iconix-audiod.js               Dienst starten
 *   node iconix-audiod.js --diag-json   Tonkanäle und Ringpuffer als JSON (für die Diagnose, eigener Prozess)
 *
 * Umgebungsvariablen:
 *   ICONIX_AUDIOD_SOCKET  zusätzlicher/ersetzender Socket-Pfad (Tests: Named Pipe unter Windows)
 *   ICONIX_STATUS_FILE    Pfad der Statusdatei (Standard /tmp/iconix-audiod.json)
 *   sowie die von engine.js
 *
 * Nur Node-8-kompatible Syntax verwenden.
 */
const fs = require('fs');
const net = require('net');
const cp = require('child_process');
const path = require('path');
const E = require('./engine');

const VERSION = '1.1.1';
const SOCKETS = process.env.ICONIX_AUDIOD_SOCKET
  ? [process.env.ICONIX_AUDIOD_SOCKET]
  : ['/run/iconix-audiod/audiod.sock', '/tmp/iconix-audiod.sock'];
const STATUS_FILE = process.env.ICONIX_STATUS_FILE || '/tmp/iconix-audiod.json';

function log(msg) { console.log(new Date().toISOString() + ' iconix-audiod: ' + msg); }

// ---------------------------------------------------------------------------
// Dienst
// ---------------------------------------------------------------------------
function runDaemon() {
  // der Player darf auch diesem Prozess Echtzeit-Priorität geben (alsa_play.py: realtime_parent)
  process.env.ICONIX_RT_PARENT = '1';
  const clients = new Set();
  const servers = [];
  let lastLine = '', lastSent = 0, diagBusy = false;

  const engine = new E.Engine({ log: log, onStatus: function () { broadcast(false); } });

  function status() {
    const s = engine.status();
    s.op = 'status'; s.version = VERSION; s.via = 'daemon'; s.at = Date.now();
    s.sockets = servers.filter(function (x) { return x.ok; }).map(function (x) { return x.path; });
    return s;
  }
  function broadcast(onlyIfChanged) {
    const line = JSON.stringify(status()) + '\n';
    const now = E.clock.now();
    if (onlyIfChanged && line.replace(/"at":\d+,?/, '') === lastLine.replace(/"at":\d+,?/, '') && now - lastSent < 5000) return;
    lastLine = line; lastSent = now;
    clients.forEach(function (c) { try { c.write(line); } catch (e) { /* egal */ } });
  }
  // Statusdatei: nur bei Änderung schreiben, sonst alle 5 s als Lebenszeichen (die App wertet < 10 s als "läuft")
  let lastFile = '', lastFileAt = 0;
  function writeStatusFile() {
    try {
      const st = status(), cmp = JSON.stringify(Object.assign({}, st, { at: 0 })), now = E.clock.now();
      if (cmp === lastFile && now - lastFileAt < 5000) return;
      lastFile = cmp; lastFileAt = now;
      const tmp = STATUS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st));
      try { fs.chmodSync(tmp, 420 /* 0644 */); } catch (e) { /* egal */ }
      fs.renameSync(tmp, STATUS_FILE);
    } catch (e) { /* /tmp nicht beschreibbar: egal */ }
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'params') engine.params(m);
    else if (m.op === 'config') { engine.configure(m.cfg); }
    else if (m.op === 'test') { log('Testsound'); engine.test(); }
    else if (m.op === 'hello') log('App verbunden: ' + m.id + ' ' + m.version);
    else if (m.op === 'diag') {
      if (diagBusy) return;
      diagBusy = true;
      // in einem eigenen Prozess (rund 1 s): im Dienst selbst setzte der Ton so lange aus
      cp.execFile(process.execPath, [__filename, '--diag-json'], { timeout: 20000, maxBuffer: 1 << 23 }, function (e, stdout) {
        diagBusy = false;
        let lines;
        try {
          const x = JSON.parse(stdout), eps = x.endpoints;
          lines = ['SmartX-Kanäle (Wiedergabe): ' + (eps.length ? eps.join(', ') : 'keine in /dev/shm'), E.ringLine(x.rings)];
        } catch (x) { lines = ['Diagnose fehlgeschlagen: ' + (e && e.message || x.message)]; }
        const msg = JSON.stringify({ op: 'diag', lines: lines }) + '\n';
        clients.forEach(function (c) { try { c.write(msg); } catch (x) { /* egal */ } });
      });
    }
  }

  function listen(p) {
    const entry = { path: p, ok: false };
    servers.push(entry);
    const isPipe = p.indexOf('\\\\.\\pipe\\') === 0;
    if (!isPipe) {
      try { fs.mkdirSync(path.dirname(p), 493 /* 0755 */); } catch (e) { /* gibt es schon */ }
      try { fs.unlinkSync(p); } catch (e) { /* gab keinen */ }
    }
    const server = net.createServer(function (sock) {
      clients.add(sock);
      sock.setEncoding('utf8');
      let rx = '';
      sock.on('data', function (d) {
        rx += d;
        let i;
        while ((i = rx.indexOf('\n')) >= 0) {
          const line = rx.slice(0, i); rx = rx.slice(i + 1);
          if (!line) continue;
          try { onMessage(JSON.parse(line)); } catch (e) { /* kaputte Zeile ignorieren */ }
        }
        if (rx.length > 65536) rx = '';
      });
      sock.on('error', function () { /* close folgt */ });
      sock.on('close', function () {
        clients.delete(sock);
        if (!clients.size) engine.configure({ steady: false });   // App weg: kein Dauerton (Abgleich)
      });
      try { sock.write(JSON.stringify(status()) + '\n'); } catch (e) { /* egal */ }
    });
    server.on('error', function (e) { log('Socket ' + p + ': ' + e.message); });
    server.listen(p, function () {
      entry.ok = true;
      if (!isPipe) { try { fs.chmodSync(p, 438 /* 0666: die App läuft ohne Root */); } catch (e) { log('chmod ' + p + ': ' + e.message); } }
      log('lauscht auf ' + p);
    });
    entry.server = server;
  }

  SOCKETS.forEach(listen);
  engine.start();
  log('Version ' + VERSION);

  setInterval(function () { broadcast(true); }, 1000);
  writeStatusFile();
  setInterval(writeStatusFile, 2000);

  function shutdown() {
    log('beende');
    engine.stop();
    servers.forEach(function (s) {
      try { s.server.close(); } catch (e) { /* egal */ }
      if (s.path.indexOf('\\\\.\\pipe\\') !== 0) { try { fs.unlinkSync(s.path); } catch (e) { /* egal */ } }
    });
    try { fs.unlinkSync(STATUS_FILE); } catch (e) { /* egal */ }
    setTimeout(function () { process.exit(0); }, 400);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', function (e) { log('Fehler: ' + (e && e.stack || e)); });
}

if (require.main === module) {
  if (process.argv.indexOf('--diag-json') >= 0) process.stdout.write(JSON.stringify({ endpoints: E.smartxEndpoints(), rings: E.rings() }));
  else runDaemon();
}

