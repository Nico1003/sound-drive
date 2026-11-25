'use strict';
/*
 * Sound Drive – Audio-Diagnose für den Alltag: aus dem Zustand von App, Dienst und Auto sechs Karten in klaren Worten und
 * ein Gesamturteil mit dem nächsten Schritt. Rein rechnend (keine Aufrufe), damit es sich prüfen lässt.
 *
 *   build({ connected, waiting, why, ds, version, outdated, rpm, rpmAge, speed, enabled, volume, route, marks }) ->
 *     { state, text, cards: [{ state, title, value, hint }] }       state: 'ok' | 'wait' | 'bad'
 *
 * route: { label, state, conn, needsAm, error, mixing, held, vol, compStep, compDb, points }
 */

const DROPS_BAD = 20;      // so viele Aussetzer seit dem Start des Dienstes fallen auf
const DATA_OLD_MS = 5000;  // so alt ist die letzte Drehzahl noch "jetzt"

function db(x) { return (x > 0 ? '+' : '') + String(Math.round(x * 10) / 10).replace('.', ',') + ' dB'; }

function service(s) {
  const c = { state: 'ok', title: 'Audio-Dienst', value: '', hint: '' };
  if (s.connected && s.ds) {
    c.value = 'läuft, Version ' + s.ds.version;
    if (s.outdated) { c.state = 'bad'; c.value = 'Version ' + s.ds.version + ' ist zu alt'; c.hint = '„Sound Drive Audio“ im Store auf ' + s.version + ' aktualisieren'; }
  } else if (s.connected || s.waiting) { c.state = 'wait'; c.value = 'verbinde …'; }
  else { c.state = 'bad'; c.value = s.why; c.hint = /läuft nicht/.test(s.why) ? '„Sound Drive Audio“ im Store installieren, dann neu starten' : 'Head Unit neu starten (Lautstärkeknopf 30 s halten)'; }
  return c;
}

function car(s) {
  const c = { state: 'ok', title: 'Daten vom Auto', value: '', hint: '' };
  if (s.rpm == null) { c.state = 'wait'; c.value = 'noch keine Drehzahl'; c.hint = 'Motor starten; hilft das nicht, Head Unit neu starten'; }
  else if (s.rpm < 100 || s.rpmAge > DATA_OLD_MS) { c.value = 'Motor aus'; }
  else c.value = Math.round(s.rpm / 10) * 10 + ' U/min, ' + Math.round(s.speed) + ' km/h';
  return c;
}

function way(s) {
  const r = s.route, c = { state: 'ok', title: 'Tonweg', value: '', hint: '' };
  if (r.mixing) c.value = r.label + ' (ohne Pause)';
  else if (r.held) { c.value = 'macht gerade der Musik Platz'; c.state = 'wait'; }
  else if (r.skipped) { c.value = 'aus bei Radio, Bluetooth, USB'; c.hint = 'so eingestellt (Einstellungen)'; }
  else if (!r.needsAm) c.value = r.label;
  else if (r.state === 'verbunden' && (!r.conn || r.conn === 'CS_CONNECTED')) c.value = r.label + ': verbunden';
  else if (r.state === 'verbunden' || r.state === 'verbinde') { c.state = 'wait'; c.value = r.label + ': wird verbunden'; }
  else if (r.state === 'Fehler') {
    c.state = 'bad';
    if (/E_NOT_POSSIBLE/.test(r.error || '')) { c.state = 'wait'; c.value = 'Auto gibt den Kanal gerade nicht frei'; c.hint = 'Ansage, Telefon oder Ton aus – kommt von selbst wieder'; }
    else if (/E_UNKNOWN/.test(r.error || '')) { c.value = 'Auto kennt diesen Weg nicht'; c.hint = 'Einstellungen > Experten > Tonweg auf „Automatisch“'; }
    else { c.value = r.error || 'nicht verbunden'; c.hint = 'Head Unit neu starten'; }
  } else { c.state = s.enabled ? 'wait' : 'ok'; c.value = s.enabled ? 'wartet auf den Motor' : 'aus (Sound ist stumm)'; }
  return c;
}

function sound(s) {
  const ds = s.ds, c = { state: 'ok', title: 'Ton', value: '', hint: '' };
  if (!s.enabled) { c.state = 'wait'; c.value = 'stumm geschaltet'; c.hint = 'Unten „Stumm / Ton an“ drücken'; return c; }
  if (s.volume <= 0) { c.state = 'wait'; c.value = 'Regler steht auf 0 %'; c.hint = 'Auf der Sound-Seite lauter stellen'; return c; }
  if (!ds) { c.state = 'wait'; c.value = 'wartet auf den Audio-Dienst'; return c; }
  if (ds.error) { c.state = 'bad'; c.value = 'Ausgabe klappt nicht'; c.hint = String(ds.error).slice(0, 90); return c; }
  const n = ds.underruns || 0, drops = n ? n + ' Aussetzer seit dem Start' : 'keine Aussetzer';
  c.value = (ds.opening ? 'Kanal öffnet' : ds.playing ? 'spielt' : 'bereit') + ', ' + drops;
  if (ds.opening) c.state = 'wait';
  if (n >= DROPS_BAD) { c.state = 'wait'; c.hint = 'Knistert es? Head Unit neu starten, sonst QR-Log schicken'; }
  return c;
}

function volume(s) {
  const r = s.route, c = { state: 'ok', title: 'Lautstärke', value: '', hint: '' };
  const pct = Math.round(s.volume * 100) + ' %';
  if (!r.compStep) c.value = 'App ' + pct + ', folgt dem Knopf';
  else if (r.vol == null) c.value = 'App ' + pct + ', Auto noch unbekannt';
  else {
    c.value = 'App ' + pct + ', Auto ' + r.vol + ' (Ausgleich ' + db(r.compDb) + ')';
    c.hint = r.points ? 'abgeglichen mit ' + r.points + (r.points === 1 ? ' Punkt' : ' Punkten') : 'noch nicht abgeglichen: Einstellungen > Lautstärke abgleichen';
    if (r.compDb >= r.compMax) c.hint = 'Musik sehr leise: lauter geht der Motor hier nicht';
  }
  return c;
}

function start(s) {
  const c = { state: 'ok', title: 'Start', value: '', hint: '' };
  const m = (n) => (s.marks || []).filter((x) => x.name === n)[0];
  const app = m('app'), play = m('play');
  if (app) c.value = (/AUTOSTART/.test(app.text) ? 'von selbst' : 'von Hand') + ' gestartet, ' + app.up + ' s nach dem Hochfahren';
  if (play && app && play.up - app.up > 30) c.hint = 'Ton kam erst ' + (play.up - app.up) + ' s später';
  return c;
}

function build(s) {
  const cards = [service(s), car(s), way(s), sound(s), volume(s), start(s)];
  const bad = cards.filter((c) => c.state === 'bad')[0];
  const wait = cards.filter((c) => c.state === 'wait')[0];
  if (bad) return { state: 'bad', text: bad.title + ': ' + (bad.hint || bad.value), cards };
  if (wait) return { state: 'wait', text: wait.title + ': ' + wait.value, cards };
  if (s.route.skipped) return { state: 'ok', text: 'Alles in Ordnung – kein Motorsound bei Radio, Bluetooth und USB (so eingestellt).', cards };
  return { state: 'ok', text: s.ds && s.ds.playing && s.rpm > 100 ? 'Alles in Ordnung – der Motorsound läuft.' : 'Alles in Ordnung – der Sound kommt mit dem Motor.', cards };
}

module.exports = { build, DROPS_BAD };
