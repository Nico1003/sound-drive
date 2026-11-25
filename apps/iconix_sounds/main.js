'use strict';
// Vor dem Laden des Kits: Das Kit hält sonst den iDrive-Controller, solange es den Bildschirm führt (GPU-Renderer),
// und das Drehrad wandert über unsere Knöpfe statt die Musik zu regeln. Bedienung der Seite per Touch.
process.env.MGU_NO_GRAB = '1';
/*
 * Sound Drive – App für den mgu-store (Format: idrive7-apps-Kit, mgu.run)
 *
 * Aufgaben der App:
 *   - Fahrzeugdaten lesen (vehicle_feed.js) und an den Audio-Daemon schicken (audio_link.js)
 *   - Bildschirm zeichnen (ui.js – identisch zum PC-Simulator)
 *   - Bedienung: iDrive drehen = Lautstärke, drücken = nächster Sound, Buttons, Einstellungen
 *
 * Der Ton selbst entsteht im Tool "iconix-audiod" (Root-Dienst) und wird in einen SmartX-Kanal geschrieben.
 * Hörbar wird er erst, wenn der BMW-Audiomanager die passende Quelle mit den Lautsprechern verbindet – das
 * fordert die App an (car_route.js), sobald der Dienst Ton ausgeben will. Der Weg ist in den Einstellungen
 * wählbar ("Tonweg"), damit sich im Auto mehrere Varianten nacheinander testen lassen.
 *
 * Die Kit-Aufrufe sind gegen idrive7-apps (kit/runtime/mgu.js, record.js, display.js, signals.js,
 * apps/redline/main.js) abgeglichen.
 */
const os = require('os');
const mgu = require('./kit/mgu');
const Profiles = require('./profiles');
const UI = require('./ui');
const AudioLink = require('./audio_link');
const VehicleFeed = require('./vehicle_feed');
const CarRoute = require('./car_route');
const Diagnose = require('./diagnose');
const Clock = require('./clock');

const VERSION = '1.1.1';
// eigener Reiter "Sound" neben "Settings" im Kopf des Kits (führt aus den Einstellungen zurück)
const TAB_INFO = { tabs: ['Sound'], sel: 0, badges: [] };
// Audiomanager-Verbindung: Sie braucht im Auto ~6 s, bis sie hörbar ist (CS_CONNECTED). Darum wird sie schon beim
// Aufwachen des Autos aufgebaut (erste Fahrzeugdaten) und gehalten, solange der Motor läuft oder kürzlich lief –
// sonst fehlten bei jedem Motorstart und nach jeder Pause ein paar Sekunden Ton.
const ROUTE_KEEP_MS = 120000;  // so lange nach dem letzten Lebenszeichen (Ton, laufender Motor, Aufwachen) halten
const BMW_SHOW_MS = 1800;      // so lange bleibt das Fenster für BMWs Lautstärkebalken nach dem letzten Dreh offen
const WAKE_GAP_MS = 300000;    // so lange ohne Fahrzeugdaten = das Auto hat geschlafen
const DEFAULTS = {
  enabled: true, profile: Profiles.DEFAULT, volume: 80, intensity: 70, sport: false,
  muteParked: false, duck: true, knobMusic: true, radio: true, knobComp: 1, followMode: true, narrow: false, speedVol: 4, startSound: true, bassDb: 0, bark: 100, loadSource: 'auto', route: 'auto', knobCal: 'off', bmwVolume: true, maxTorque: 400, carIdle: 800, carRedline: 4800
};

function setting(settings, key) {
  let v;
  try { v = settings && settings.get ? settings.get(key) : undefined; } catch (e) { v = undefined; }
  return v === undefined || v === null ? DEFAULTS[key] : v;
}
function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

// ---------------------------------------------------------------------------
// Kern: Fahrzeugdaten -> Audio-Daemon. Läuft einmal pro Prozess, im Vordergrund
// und (mit "autostart") im Hintergrund, damit der Sound auch ohne offene App spielt.
// ---------------------------------------------------------------------------
let core = null;

function startCore(host) {
  if (core) return core;
  const log = host.log || console;
  const settings = host.settings;

  // Einstellungen werden nur bei Änderungen gelesen und dann zwischengespeichert –
  // nicht in jedem Frame bzw. bei jedem Drehzahl-Update.
  let parkedMute = false;
  let driveMode = null;      // Fahrerlebnisschalter: eco | comfort | sport | sportplus
  let last = null;
  let feedCfg = null, synthCfgCache = null, uiCfg = null;
  let effRoute = CarRoute.DEFAULT_ROUTE;   // gerade benutzter Tonweg ("auto" wechselt ihn, siehe CarRoute.pick)
  let volPreview = null;     // Lautstärke (0..100), solange der Regler gezogen wird – erst beim Loslassen gespeichert

  const refresh = () => {
    const g = k => setting(settings, k);
    feedCfg = {
      loadSource: String(g('loadSource')),
      maxTorque: num(g('maxTorque'), 400),
      carIdle: num(g('carIdle'), 800)
    };
    synthCfgCache = {
      enabled: bool(g('enabled')) && !parkedMute,
      profile: Profiles.ids.indexOf(String(g('profile'))) >= 0 ? String(g('profile')) : Profiles.DEFAULT,
      volume: Math.min(100, volPreview != null ? volPreview : num(g('volume'), 80)) / 100,
      intensity: num(g('intensity'), 70) / 100,
      sport: bool(g('sport')),
      carIdle: feedCfg.carIdle,
      carRedline: num(g('carRedline'), 4800),
      route: CarRoute.setting(String(g('route'))) ? String(g('route')) : 'auto',
      device: 'auto',
      duck: false,
      mode: bool(g('followMode')) ? driveMode : null,
      speedVol: num(g('speedVol'), 4),
      startSound: bool(g('startSound')),
      bassDb: num(g('bassDb'), 0),
      barkPct: num(g('bark'), 100) / 100
    };
    // Gerät für den Dienst: SmartX-Kanal des Tonwegs
    const rt = CarRoute.route(effRoute);
    // der Dienst soll beobachten, ob in CarPlay / Android Auto gerade Musik läuft
    synthCfgCache.mixProbe = synthCfgCache.route === 'auto' ? CarRoute.MIX_CHANNELS : [];
    synthCfgCache.device = rt.device;
    synthCfgCache.steady = String(g('knobCal')) === 'on' && feed.speed() < 1;
    uiCfg = { muteParked: bool(g('muteParked')), duck: bool(g('duck')), wide: !bool(g('narrow')), knobMusic: bool(g('knobMusic')), radio: bool(g('radio')), knobComp: num(g('knobComp'), 1), cal: String(g('knobCal')) };
  };

  const link = new AudioLink(log, VERSION);
  const feed = new VehicleFeed(host.signals, log, () => feedCfg);
  refresh();
  const synthCfg = () => synthCfgCache;
  let ducked = false, held = true;   // held: Kanal gerade nicht hörbar (noch nicht verbunden, weg, Knopf gedreht) -> leise
  let outDb = 0;             // Ausgleich des Lautstärkeknopfs (CarRoute.compDb)
  const pushCfg = () => {
    refresh(); synthCfgCache.outDb = outDb; synthCfgCache.duck = ducked; synthCfgCache.hold = held; link.configure(synthCfgCache);
    if (core) { core.route.setDuck(uiCfg.duck); core.route.setKnob(uiCfg.knobMusic); core.route.setRadio(uiCfg.radio); core.route.setComp(uiCfg.knobComp); calMode(); }
  };
  // Abgleich der Lautstärke (Einstellung): gleichmäßiger Ton, +/− stellt den Motorsound bei der jetzigen Auto-Lautstärke nach
  let calOn = false;
  const setSetting = (k, v) => { try { settings.set(k, v); } catch (e) { log.warn('iconix: settings.set ' + k + ': ' + e.message); } };
  const calMode = () => {
    if (uiCfg.cal === 'reset') { core.route.resetCurve(); log.info('iconix: Abgleich zurückgesetzt'); uiCfg.cal = 'off'; setSetting('knobCal', 'off'); }
    const on = uiCfg.cal === 'on';
    if (on && !calOn) { calAnchor = false; lastActivity = Clock.now(); }
    calOn = on;
  };
  let calAnchor = false;
  let lastActivity = 0, lastData = 0, pendingTest = 0;

  // Autostart nachvollziehen: wann nach dem Hochfahren des Head Units kam die App, die Drehzahl, der Tonweg, der Ton?
  // Steht im Log (QR-Log) und in der Audio-Diagnose.
  const marks = [];
  const mark = (name, text) => {
    if (marks.some(x => x.name === name)) return;
    const x = { name, text, up: Math.round(os.uptime()) };
    marks.push(x);
    log.info('iconix: Start: ' + text + ' ' + x.up + ' s nach dem Hochfahren');
  };
  mark('app', 'App (' + String((host.app && host.app.startReason) || '?') + ')');

  feed.on('sample', s => {
    const now = Clock.now();
    if (!lastData) mark('data', 'erste Drehzahl (' + Math.round(s.rpm) + ')');
    // Aufwachen (erste Daten nach Schlaf/Start) oder laufender Motor halten den Tonweg bereit
    if (now - lastData > WAKE_GAP_MS || s.rpm > 300) lastActivity = now;
    lastData = now;
    last = s;
    link.params(s);
    const shouldMute = uiCfg.muteParked && s.speed < 0.5;
    if (shouldMute !== parkedMute) { parkedMute = shouldMute; pushCfg(); }
  });

  // Fahrmodus: Sound wird in Eco dezenter, in Sport aggressiver (Einstellung "Sound folgt dem Fahrmodus")
  feed.on('mode', m => { driveMode = m; log.info('iconix: Fahrmodus ' + m); pushCfg(); });

  pushCfg();
  link.connect();
  feed.start();

  // Audiomanager-Verbindung: ab dem Aufwachen und solange der Motor läuft (oder Ton gewünscht ist) – siehe ROUTE_KEEP_MS
  const route = new CarRoute(host.signals, log, host.dataDir);
  let switching = null;
  const wantRoute = () => bool(setting(settings, 'enabled')) && lastActivity > 0 && Clock.now() - lastActivity < ROUTE_KEEP_MS;
  // hörbar oder nicht (verbindet noch, Verbindung weg, Lautstärkeknopf gedreht): Ton weich aus- bzw. einblenden
  route.onChange = audible => { if (switching || held === !audible) return; held = !audible; synthCfgCache.hold = held; link.configure(synthCfgCache); };
  setInterval(() => {
    const ds = link.connected ? link.daemonStatus : null;
    const now = Clock.now();
    if (calOn) {
      lastActivity = now;
      if (!calAnchor && route.compVol !== null) { calAnchor = true; route.calStart(); }
      // losgefahren: Abgleich beenden
      if (feed.speed() > 3) { uiCfg.cal = 'off'; setSetting('knobCal', 'off'); pushCfg(); }
    }
    if (link.connected) mark('daemon', 'Audio-Dienst verbunden');
    if (route.audible()) mark('route', 'Tonweg hörbar');
    if (ds && ds.playing) mark('play', 'Ton läuft' + (ds.openMs > 3000 ? ' (Kanal öffnete erst nach ' + Math.round(ds.openMs / 1000) + ' s)' : ''));
    if (ds && (ds.wants || ds.playing || ds.opening) && last && last.rpm > 100) lastActivity = now;
    const next = route.pick(synthCfgCache.route, ds && ds.mix, ds && ds.device === CarRoute.route(effRoute).device ? ds.error : null);
    // Wechsel des Wegs: erst ausblenden, dann umschalten
    if (next !== effRoute && !switching) {
      const apply = () => {
        switching = null;
        effRoute = next;
        route.want(effRoute, wantRoute());
        held = !route.audible();
        pushCfg();
      };
      if (ds && ds.playing && !held) { held = true; synthCfgCache.hold = true; link.configure(synthCfgCache); switching = setTimeout(apply, 200); }
      else apply();
    }
    if (!switching) route.want(effRoute, wantRoute());
    // Telefon, Navi-Ansage, Parkpiepser: Motorsound absenken (CarRoute beobachtet den Audiomanager)
    if (route.ducked !== ducked) { ducked = route.ducked; synthCfgCache.duck = ducked; link.configure(synthCfgCache); }
    // wartender Testsound: starten, sobald der Tonweg hörbar ist (spätestens nach 10 s)
    if (pendingTest && (route.audible() || now - pendingTest > 10000)) { pendingTest = 0; link.test(); }
  }, 500);
  route.setDuck(uiCfg.duck);
  route.setKnob(uiCfg.knobMusic);
  route.setRadio(uiCfg.radio);
  // am Knopf gedreht: Motorsound sofort gegenregeln, damit er gleich laut bleibt
  route.onComp = db => { if (db === outDb) return; outDb = db; synthCfgCache.outDb = db; link.configure(synthCfgCache); };
  route.setComp(uiCfg.knobComp);
  // ein vergessener Abgleich läuft nach einem Neustart nicht weiter
  if (uiCfg.cal !== 'off') { setSetting('knobCal', 'off'); pushCfg(); }
  route.start();
  // die Plattform beendet die App (Update, Abschalten): Tonweg sauber freigeben
  if (host.app && typeof host.app.on === 'function') host.app.on('shutdown', () => { route.stop(); });
  log.info('iconix: Kern gestartet, Version ' + VERSION + ', Tonweg ' + synthCfgCache.route);

  // Testsound: Tonweg sofort bereitstellen; ist er noch nicht hörbar (verbindet ~6 s), startet der Test, sobald er es ist
  const test = () => { lastActivity = Clock.now(); if (route.audible()) link.test(); else pendingTest = Clock.now(); };
  // Regler ziehen: Lautstärke sofort hören und sehen, ohne bei jedem Schritt die Einstellungsdatei zu schreiben
  const previewVolume = v => {
    if (v === volPreview) return;
    const prev = volPreview;
    volPreview = v;
    // Vorschau endet mit genau dem gespeicherten Wert: hörbar ändert sich nichts, nichts senden
    if (v == null && prev === num(setting(settings, 'volume'), 80)) return;
    pushCfg();
  };
  const cal = () => (calOn ? { vol: route.compVol, db: route.compVol === null ? 0 : route.curveAt(route.compVol), off: !uiCfg.knobComp } : null);
  core = { link, feed, route, pushCfg, cal, calAdjust: d => route.calAdjust(d), synthCfg, test, previewVolume, ui: () => uiCfg, last: () => last, speed: () => feed.speed(),
    marks,
    diag: () => Diagnose.build({ connected: link.connected, waiting: link.waiting(), why: link.why(), ds: link.connected ? link.daemonStatus : null, version: VERSION, outdated: outdated(link),
      rpm: last ? last.rpm : null, rpmAge: last ? Clock.now() - last.at : 0, speed: feed.speed(), enabled: bool(setting(settings, 'enabled')), volume: synthCfgCache.volume, route: route.info(), marks }) };
  return core;
}

// ---------------------------------------------------------------------------
// Grafik-Adapter: ui.js -> Kit-Recorder (kit/runtime/record.js, geprüft gegen idrive7-apps)
//   fillRect(x, y, w, h, c) · roundRect(x, y, w, h, r, c) · text(str, x, baselineY, size, c, {font, align, literal})
//   arc(cx, cy, r0, r1, a0, a1, c, opts): Winkel in GRAD, im Uhrzeigersinn ab 12 Uhr
//   Farben: '#rrggbb' (canvas.js rgba)
// Umlaute, ß und Anführungszeichen haben die Schriften des Kits seit 1.1.1 (kit/tools/bake_german.py).
// ---------------------------------------------------------------------------
const RAD2DEG = 180 / Math.PI;
function kitGfx(c) {
  return {
    rect: (x, y, w, h, col) => c.fillRect(x, y, w, h, col),
    rrect: (x, y, w, h, r, col) => c.roundRect(x, y, w, h, r, col),
    text: (s, x, y, size, col, align, weight) => c.text(String(s), x, y, size, col, { align: align || 'left', font: weight === 'light' ? 'light' : (weight ? 'bold' : 'label'), literal: true }),
    line: (xa, ya, xb, yb, w, col) => c.line(xa, ya, xb, yb, w, col),
    arc: (cx, cy, r, th, a0, a1, col) => {
      // ui.js: Radiant ab 3 Uhr -> Kit: Grad ab 12 Uhr; über 360° hinaus in zwei Stücke teilen
      let d0 = a0 * RAD2DEG + 90, d1 = a1 * RAD2DEG + 90;
      while (d0 >= 360) { d0 -= 360; d1 -= 360; }
      if (d1 <= 360) c.arc(cx, cy, r - th, r, d0, d1, col);
      else { c.arc(cx, cy, r - th, r, d0, 360, col); c.arc(cx, cy, r - th, r, 0, d1 - 360, col); }
    }
  };
}


/** a < b für Versionen wie "1.0.4" (Teile als Zahlen). */
function olderVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Tool älter als die App (nur die App aktualisiert)? Neue Sounds kennt der Dienst dann nicht – darauf hinweisen. */
function outdated(link) {
  const ds = link.connected ? link.daemonStatus : null;
  return ds && ds.version && olderVersion(String(ds.version), VERSION) ? String(ds.version) : '';
}

// Statuszeile: Tonweg und Dienst; neues Objekt nur, wenn sich etwas ändert
let audioCache = { key: '', val: null };
function audioStatus(c) {
  const l = c.link, ds = l.connected ? l.daemonStatus : null, r = c.route.short(), old = outdated(l);
  const svc = !l.connected ? (l.waiting() ? 'verbinde …' : l.why()) : !ds ? 'verbunden' : ds.error ? ds.error : ds.opening ? 'öffnet Kanal' : ds.playing ? 'spielt' : 'bereit';
  const ok = l.connected && !(ds && ds.error) && (!c.route.needsAm() || /^(verbunden|aus|Pause)/.test(c.route.state));
  const key = svc + '|' + ok + '|' + r + '|' + old;
  if (key !== audioCache.key) {
    audioCache = { key, val: old ? { ok: false, text: 'Sound Drive Audio ' + old + ' veraltet – bitte auf ' + VERSION + ' aktualisieren' }
      : !l.connected ? { ok: false, text: 'Audio-Dienst: ' + svc } : { ok, text: r + ' · ' + svc } };
  }
  return audioCache.val;
}

// Diagnosezeilen auf die Breite der Seite umbrechen (~64 Zeichen)
function wrapLines(lines, width) {
  const W = width || 64;
  const out = [];
  lines.forEach(l => {
    let s = String(l);
    while (s.length > W) {
      const cut = Math.max(s.lastIndexOf(', ', W), s.lastIndexOf(' ', W));
      const i = cut > 20 ? cut + 1 : W;
      out.push(s.slice(0, i));
      s = '   ' + s.slice(i).replace(/^\s+/, '');
    }
    out.push(s);
  });
  return out;
}

mgu.run({
  // Autostart (app.json "autostart": true): die Plattform startet die App beim Hochfahren ohne Bildschirm;
  // dann läuft nur der Kern (Fahrzeugdaten -> Dienst, Audiomanager-Verbindung). Öffnet man die App später,
  // nutzt start() denselben Kern. Laut kit/runtime/mgu.js: bg = { app, log, settings, signals, spec, dataDir }.
  background(bg) { return startCore(bg); },
  async start(ctx) {
    const c = startCore(ctx);
    const log = ctx.log || console;
    const get = k => setting(ctx.settings, k);
    // settings.set meldet die Änderung selbst über onChange (-> pushCfg); nur ohne onChange hier nachschieben,
    // sonst ginge jede Änderung zweimal an den Dienst
    const hasOnChange = !!(ctx.settings && ctx.settings.onChange);
    const set = (k, v) => {
      try { ctx.settings.set(k, v); } catch (e) { log.warn('iconix: settings.set ' + k + ': ' + e.message); }
      if (!hasOnChange) c.pushCfg();
    };

    if (hasOnChange) ctx.settings.onChange(() => c.pushCfg());

    const nextProfile = () => set('profile', Profiles.next(String(get('profile')), 1));
    const changeVolume = steps => {
      if (c.cal()) { c.calAdjust(steps); return; }
      const v = Math.max(0, Math.min(100, Math.round((num(get('volume'), 80) + steps * 5) / 5) * 5));
      set('volume', v);
    };

    // Buttons aus app.json
    ctx.ui.onClick('BTN_PROFILE', nextProfile);
    // Wo das Kit den Bildschirm führt: Sound wählt man über die Kacheln, die Einstellungen über den Reiter oben –
    // "Sound wechseln" aus der unteren Leiste nehmen (Einstellungen blendet das Kit dort ohnehin aus), sonst reicht
    // die Breite nicht und "Audio-Diagnose" wird abgeschnitten
    if (ctx.hideButton) ctx.hideButton('BTN_PROFILE');
    ctx.ui.onClick('BTN_MUTE', () => set('enabled', !bool(get('enabled'))));
    ctx.ui.onClick('BTN_TEST', () => c.test());
    // Audio-Diagnose (an/aus): Übersicht in klaren Worten, auf Wunsch die technischen Zeilen (Audiomanager und Dienst, kommen
    // asynchron; sie stehen auch im QR-Log)
    let diag = null, routeLines = [];
    const diagText = () => wrapLines(['Start: ' + c.marks.map(x => x.text + ' ' + x.up + ' s').join(' · ') + ' (nach dem Hochfahren)'].concat(routeLines.length ? routeLines : ['(Audiomanager wird abgefragt …)'],
      c.link.daemonDiag || ['(Dienst wird abgefragt …)']), c.ui().wide ? 100 : 64);
    const refreshDiag = d => { if (diag === d) d.lines = diagText(); };
    const openDiag = () => {
      const d = diag = { model: c.diag(), at: Clock.now(), details: false, lines: [], page: 0 };
      d.lines = diagText();
      c.link.diagnose();
      c.route.diagLines().then(l => { routeLines = l; refreshDiag(d); }, e => { routeLines = ['Audiomanager: ' + e]; refreshDiag(d); });
    };
    ctx.ui.onClick('BTN_DIAG', () => { if (diag) diag = null; else openDiag(); });
    c.link.on('diag', () => refreshDiag(diag));

    // Bedienbare Flächen (Profil-Chips, Lautstärke −/+, Stumm) – Geometrie aus ui.js
    const act = h => {
      if (h.act === 'profile') set('profile', h.arg);
      else if (h.act === 'vol') changeVolume(h.arg);
      else if (h.act === 'mute') set('enabled', !bool(get('enabled')));
      else if (h.act === 'diagMode' && diag) { diag.details = !diag.details; diag.page = 0; }
      else if (h.act === 'diagNext' && diag) diag.page++;
      else if (h.act === 'diagClose') diag = null;
    };
    // Touch-Ziele je Ansicht (schmal: Seitenfenster frei, breit: ganze Seite)
    const mkHits = wide => ({ main: UI.hits(Profiles.list, wide).map(h => Object.assign({ run: () => act(h) }, h)),
      diag: UI.hitsDiag(wide, false).map(h => Object.assign({ run: () => act(h) }, h)),
      details: UI.hitsDiag(wide, true).map(h => Object.assign({ run: () => act(h) }, h)) });
    const HITS_BY = { narrow: mkHits(false), wide: mkHits(true) };

    // Zwei Betriebsarten des Kits (kit/runtime/display.js):
    //  - "Kit führt den Bildschirm" (cv.own: GPU-Renderer mit Touch-Weiterleitung): Touch und der iDrive-Knopf
    //    gehen über die Ziele aus cv.target(...) – Drehen wandert über Chips/Knöpfe/Leiste, Drücken löst aus.
    //    ctx.controller.onInput bekommt dann nichts (das Kit wertet den Knopf selbst aus).
    //  - sonst: Bedienung über die Knöpfe der Seite (Sound wechseln, Stumm, Testsound) und die Einstellungen.
    // Der iDrive-Knopf wird bewusst NICHT mehr belegt (controller.grab): Er blieb sonst auch außerhalb der App
    // gefangen und regelte nur noch Sound Drive statt der Musik.
    let own = false;
    if (ctx.controller && ctx.controller.grab) { try { ctx.controller.grab(false); } catch (e) { /* egal */ } }
    // Rückfall: Tippen ohne Ziel (falls ein Kit-Stand Taps nur über onTap liefert)
    // Reiter im Kopf (wo das Kit den Bildschirm führt): "Sound" = diese Seite; schließt eine offene Einstellungsseite
    if (ctx.onTab) ctx.onTab(() => { lastKey = ''; });
    // Lautstärke-Regler: antippen oder mit dem Finger ziehen (ganze Geste über ctx.onTouch). Rastet in 5-%-Schritten
    // (wie die Auswahl in den Einstellungen). Beim Ziehen gilt der Wert sofort (Vorschau, höchstens alle 60 ms an den
    // Dienst), gespeichert wird erst beim Loslassen.
    const volOf = f => Math.round(f * 20) * 5;
    const setVolFrac = f => {
      const v = volOf(f);
      c.previewVolume(v);                                  // (schon so, wenn gezogen wurde: dann nichts zu senden)
      if (v !== num(get('volume'), 80)) set('volume', v);
      c.previewVolume(null);
    };
    let volDrag = null;
    // Geste ohne "Loslassen" (z. B. Einstellungen gehen mitten im Ziehen auf): nach 1,5 s ohne Bewegung übernehmen,
    // sonst bliebe die Vorschau hängen und die gespeicherte Lautstärke wäre wirkungslos
    const endDrag = () => { const d = volDrag; if (!d) return; volDrag = null; clearTimeout(d.timer); setVolFrac(d.f); };
    const armDrag = () => { clearTimeout(volDrag.timer); volDrag.timer = setTimeout(endDrag, 1500); };
    if (ctx.onTouch) {
      ctx.onTouch((phase, x, y) => {
        if (phase === 1) {
          if (volDrag) endDrag();
          if (diag || c.cal()) return false;
          const f = UI.volAt(x, y, c.ui().wide);
          if (f < 0) return false;
          volDrag = { t: Clock.now(), f, timer: null };
          armDrag();
          c.previewVolume(volOf(f));
          return true;
        }
        if (!volDrag) return false;
        volDrag.f = UI.volAt(x, y, c.ui().wide, true);
        if (phase === 3) { endDrag(); return true; }
        armDrag();
        if (Clock.now() - volDrag.t >= 60) { volDrag.t = Clock.now(); c.previewVolume(volOf(volDrag.f)); }
        return true;
      });
    }
    // BMWs eigener Lautstärkebalken liegt sonst unter unserer Seite: beim Drehen dort ein Fenster öffnen
    c.route.page = true;
    if (ctx.ui.onVisible) ctx.ui.onVisible((name, on) => { if (name === 'MAIN') c.route.page = !!on; });
    c.route.onTurn = () => { if (ctx.peekVolume && bool(get('bmwVolume')) && c.route.page) ctx.peekVolume(BMW_SHOW_MS); };
    if (ctx.onTap) {
      ctx.onTap((x, y) => {
        const h = UI.hitAt(Profiles.list, x, y, diag, c.ui().wide);
        if (h) { act(h); return; }
        const f = diag || c.cal() ? -1 : UI.volAt(x, y, c.ui().wide);
        if (f >= 0) setVolFrac(f);
      });
    }

    // Bildschirm (wie apps/redline/main.js): pro Frame ctx.canvas(W, H) holen – das Kit gibt denselben,
    // zurückgesetzten Recorder zurück – und an das Grafik-Widget "<SCREEN>_GFX" übergeben.
    // Mit GPU-Renderer ruft das Kit die Schleife bis zu 60x/s; ein Frame ohne Änderung wird nicht gesendet.
    // Ohne Renderer (PNG-Weg) gilt die angefragte Rate: 20 fps reichen für die Drehzahlanzeige.
    // Das Zustandsobjekt wird wiederverwendet (keine Allokation pro Frame).
    // Nur neu zeichnen, wenn sich etwas Sichtbares ändert: höchstens 30 Bilder/s beim Fahren, sonst 1/s.
    // Der GPU-Renderer ruft die Schleife bis zu 60x/s auf – ohne diese Bremse würde jedes Mal gezeichnet.
    const st = { profiles: Profiles.list };
    let lastKey = '', lastDraw = 0;
    ctx.loop('MAIN', 20, () => {
      const s = c.last();
      const cfg = c.synthCfg();
      const a = audioStatus(c), now = Clock.now(), k = c.cal();
      if (diag && now - diag.at >= 500) { const m = c.diag(); if (JSON.stringify(m) !== JSON.stringify(diag.model)) { diag.model = m; diag.at = now; } }
      const key = cfg.profile + '|' + cfg.enabled + '|' + cfg.volume + '|' + cfg.sport + '|' + cfg.mode + '|' + c.ui().wide + '|' + cfg.carRedline + '|' +
        (s ? Math.round(s.rpm / 10) : '-') + '|' + Math.round(c.speed()) + '|' + a.text + '|' + a.ok + '|' +
        (diag ? diag.details + ':' + diag.page + ':' + diag.lines.length + ':' + diag.at : '') + (k ? '|' + k.vol + '|' + k.db + '|' + k.off : '');
      if (now - lastDraw < 33 || (key === lastKey && now - lastDraw < 1000)) return undefined;
      lastKey = key; lastDraw = now;
      const cv = ctx.canvas(UI.W, UI.H);
      // ganze Fläche im Seitenhintergrund löschen (nicht nur die Seite): sonst schimmert im Vollbild links unten und am
      // Rand das HMI grau durch
      if (cv.clear) cv.clear(UI.colors.bg);
      // ein eigener Reiter "Sound" neben "Settings": Tippen darauf führt aus den Einstellungen zurück
      cv.tabInfo = TAB_INFO;
      const g = kitGfx(cv);
      if (!!cv.own !== own) { own = !!cv.own; log.info('iconix: Kit führt den Bildschirm: ' + own); lastKey = ''; }
      st.profile = cfg.profile;
      st.rpm = s ? s.rpm : 0; st.speed = c.speed();
      st.redline = cfg.carRedline; st.volume = cfg.volume; st.enabled = cfg.enabled;
      st.sport = cfg.sport; st.demo = !s; st.mode = cfg.mode; st.wide = c.ui().wide; st.own = own;
      st.audio = a; st.cal = k;
      st.diag = diag;
      UI.draw(g, st);
      // Ziele nach dem Zeichnen registrieren (wie apps/dyno, live_data: nur wenn cv.own)
      if (own && typeof cv.target === 'function') {
        const hb = HITS_BY[c.ui().wide ? 'wide' : 'narrow'], list = diag ? (diag.details ? hb.details : hb.diag) : hb.main;
        for (let i = 0; i < list.length; i++) { const h = list[i]; cv.target(h.x, h.y, h.w, h.h, h.run, h.key, h.r); }
      }
      return ctx.ui.image('MAIN_GFX', cv);
    });

    log.info('iconix: Vordergrund gestartet');
  }
});
