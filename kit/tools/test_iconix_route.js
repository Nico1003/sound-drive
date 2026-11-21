'use strict';
/**
 * Tests für Iconix Sounds 0.6: Audiomanager-Tonweg (car_route.js) gegen einen nachgebauten Audiomanager
 * und die SmartX-Ausgabe des Dienstes (engine.js: Kanal auflösen, Format, Umrechnung).
 *
 *   node kit/tools/test_iconix_route.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CarRoute = require(path.join(ROOT, 'apps/iconix_sounds/car_route.js'));
const E = require(path.join(ROOT, 'tools/iconix-audiod/engine.js'));

// ---- nachgebauter Audiomanager ------------------------------------------------
function fakeAm(opts) {
  opts = opts || {};
  const am = { conns: opts.conns || [], nextId: 50, calls: [], avail: {}, vol: 20, state: opts.state };
  const signals = {
    proxy: async (iface, inst) => {
      assert.strictEqual(inst, '1');
      if (opts.noProxy) throw new Error('no SOME/IP config');
      return { iface };
    },
    call: async (p, method, params) => {
      am.calls.push(method + ' ' + JSON.stringify(params));
      if (method === 'getListMainConnections') return { listConnections: am.conns.map((c) => Object.assign({}, c)) };
      if (method === 'getListMainSources') return { listMainSources: opts.sources || [{ sourceID: 287, name: 'CarLifeMedia' }, { sourceID: 1048, name: 'OAPGenericOverlay' }] };
      if (method === 'getListMainSinks') return { listMainSinks: [{ sinkID: 1024, name: 'MediaSink_Front' }, { sinkID: 1, name: 'MainSink', volume: am.vol }] };
      if (method === 'hookSourceAvailablityStatusChange') { am.avail[params.sourceID] = params.availability.availability; return {}; }
      if (method === 'connect') {
        if (opts.refuse) return { amError: 'E_NOT_POSSIBLE', mainConnectionID: null };
        const id = am.nextId++;
        am.conns.push({ mainConnectionID: id, sourceID: params.sourceID, sinkID: params.sinkID, connectionState: am.state != null ? am.state : 2 });
        return { amError: 'E_OK', mainConnectionID: id };
      }
      if (method === 'disconnect') { am.conns = am.conns.filter((c) => c.mainConnectionID !== params.mainConnectionID); return { amError: 'E_OK' }; }
      throw new Error('unbekannt ' + method);
    }
  };
  return { am, signals };
}
const quiet = { info() {}, warn() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-route-'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Overlay-Mix verbindet 1048 -> 1024 ohne Verfügbarkeitsmeldung und trennt wieder', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, tmp);
  r.want('overlay', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[1048, 1024]]);
  assert.strictEqual(am.avail[1048], undefined);
  assert.ok(fs.existsSync(path.join(tmp, 'iconix_route.json')));
  r.want('overlay', false);
  await r._step();
  assert.strictEqual(am.conns.length, 0);
  assert.strictEqual(r.state, 'aus');
  assert.ok(!fs.existsSync(path.join(tmp, 'iconix_route.json')));
});

test('CarLife exklusiv meldet 287 verfügbar, übernimmt fremde 287-Verbindung, meldet beim Trennen unverfügbar', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 7, sourceID: 287, sinkID: 1, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('carlife', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[287, 1024]]);
  assert.strictEqual(am.avail[287], 'A_AVAILABLE');
  r.want('carlife', false);
  await r._step();
  assert.strictEqual(am.avail[287], 'A_UNAVAILABLE');
});

test('Wegwechsel trennt den alten Weg zuerst', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  r.want('carlifeNav', true); await r._step();
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[288, 1024]]);
});

test('bestehende passende Verbindung wird übernommen, verschwundene neu aufgebaut', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 9, sourceID: 1048, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  assert.strictEqual(r.conn.id, 9);
  assert.ok(!am.calls.some((c) => c.indexOf('connect {') === 0));
  am.conns = [];          // z. B. vom System getrennt
  r.lastVerify = 0; await r._step();
  assert.strictEqual(r.conn, null);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.strictEqual(am.conns.length, 1);
});

test('Ablehnung und fehlendes SOME/IP werden als Fehler angezeigt, ohne zu werfen', async () => {
  const a = fakeAm({ refuse: true });
  const r = new CarRoute(a.signals, quiet, null);
  r.want('carlife', true); await r._step();
  assert.strictEqual(r.state, 'Fehler');
  assert.ok(/E_NOT_POSSIBLE/.test(r.short()), r.short());
  assert.strictEqual(a.am.avail[287], 'A_UNAVAILABLE');
  const b = fakeAm({ noProxy: true });
  const r2 = new CarRoute(b.signals, quiet, null);
  r2.want('overlay', true); await r2._step();
  assert.ok(/nicht erreichbar/.test(r2.short()), r2.short());
  const r3 = new CarRoute(null, quiet, null);
  r3.want('overlay', true); await r3._step();
  assert.strictEqual(r3.state, 'Fehler');
});

test('Wege ohne Audiomanager machen keine Aufrufe', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('carplay', true); await r._step();
  r.want('alsa', true); await r._step();
  assert.strictEqual(am.calls.length, 0);
  assert.ok(/ohne Audiomanager/.test(r.short()));
});

test('liegengebliebene eigene Verbindung desselben Boots wird beim Start getrennt', async () => {
  const boot = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-route2-'));
  fs.writeFileSync(path.join(dir, 'iconix_route.json'), JSON.stringify({ mainConnectionID: 33, bootId: boot }));
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 33, sourceID: 287, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, dir);
  r.want('overlay', true); await r._step();
  if (boot) assert.ok(!am.conns.some((c) => c.mainConnectionID === 33));
  else assert.ok(am.conns.some((c) => c.mainConnectionID === 33)); // ohne Boot-ID (Windows) nichts anfassen
});

test('Diagnose listet Verbindungen, Quellen und Senken', async () => {
  const { signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  const lines = (await r.diagLines()).join('\n');
  assert.ok(/1048->1024 CONNECTED/.test(lines), lines);
  assert.ok(/287 CarLifeMedia/.test(lines) && /1024 MediaSink_Front/.test(lines), lines);
});

test('SmartX: Kanal auflösen, Format aus dem Namen, kein Rückfall auf andere Geräte', () => {
  assert.strictEqual(E.resolveSmartx('smartx:Media_Overlay_Converter_Source_CF_24_MONO', ['Media_Overlay_Converter_Source_CF_24_MONO']),
    'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO');
  assert.strictEqual(E.resolveSmartx('smartx:Media_Overlay_Converter_Source_CF_24_MONO', ['Media_Overlay_Converter_Source_CF_48_STEREO']),
    'plug:smartx:Media_Overlay_Converter_Source_CF_48_STEREO');
  assert.strictEqual(E.resolveSmartx('smartx:CarLifeNavigation', []), 'plug:smartx:CarLifeNavigation_CF_48_STEREO');
  assert.strictEqual(E.resolveSmartx('plughw:0,0', []), 'plughw:0,0');
  assert.deepStrictEqual(E.formatOf('plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO'), { rate: 24000, ch: 1 });
  assert.deepStrictEqual(E.formatOf('plug:smartx:CarLifeMedia_CF_48_STEREO'), { rate: 48000, ch: 2 });
  process.env.ICONIX_PYTHON = process.execPath; // irgendein vorhandenes Programm als "Python"
  const c = E.candidates({ device: 'plug:smartx:CarLifeMedia_CF_48_STEREO' });
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].argv.slice(1), ['play', 'plug:smartx:CarLifeMedia_CF_48_STEREO', '48000', '30000', '2']);
  const m = E.candidates({ device: 'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO' });
  assert.deepStrictEqual(m[0].argv.slice(3), ['24000', '30000', '1']);
});

test('Umrechnung 48 -> 24 kHz: Tiefpass gegen Aliasing, tiefe Töne bleiben', () => {
  const tone = (hz, n) => { const f = new Float32Array(n * 2); for (let i = 0; i < n; i++) f[i * 2] = f[i * 2 + 1] = 0.5 * Math.sin(2 * Math.PI * hz * i / 48000); return f; };
  const rms = (b) => { let s = 0; const m = b.length / 2; for (let i = m / 2; i < m; i++) { const v = b.readInt16LE(i * 2) / 32767; s += v * v; } return Math.sqrt(s / (m / 2)); };
  const n = 9600;
  const low = E.toPcmFmt(tone(500, n), n, { rate: 24000, ch: 1 }, new E.Decimator(2));
  const high = E.toPcmFmt(tone(18000, n), n, { rate: 24000, ch: 1 }, new E.Decimator(2)); // würde als 6 kHz zurückfallen
  assert.strictEqual(low.length, n); // n/2 Frames x 2 Byte
  assert.ok(rms(low) > 0.3, 'tiefer Ton bleibt: ' + rms(low));
  assert.ok(rms(high) < 0.005, '18 kHz wird unterdrückt: ' + rms(high));
  // Zustand über Blöcke: zwei halbe Blöcke = ein ganzer
  const dec = new E.Decimator(2), t = tone(500, n);
  const a = E.toPcmFmt(t.subarray(0, n), n / 2, { rate: 24000, ch: 1 }, dec);
  const b = E.toPcmFmt(t.subarray(n), n / 2, { rate: 24000, ch: 1 }, dec);
  assert.ok(Buffer.concat([a, b]).equals(low));
  assert.strictEqual(E.toPcmFmt(t, n, { rate: 48000, ch: 2 }).length, n * 4);
});

// ---- Synthese (synth.js v2) ----------------------------------------------------
const Synth = require(path.join(ROOT, 'tools/iconix-audiod/synth.js'));
const Profiles = require(path.join(ROOT, 'tools/iconix-audiod/profiles.js'));
function drive(id, sr, secs, fn) {
  const s = new Synth(sr);
  s.configure({ profile: id, volume: 1, intensity: 0.7 });
  s._setProfile(id); s.pending = null; s._reset();
  const blk = Math.round(sr / 100), f = new Float32Array(blk * 2), out = new Float32Array(Math.round(secs * sr));
  let peak = 0;
  for (let pos = 0; pos + blk <= out.length; pos += blk) {
    s.setParams(fn(pos / sr));
    peak = Math.max(peak, s.render(f, blk));
    for (let i = 0; i < blk; i++) out[pos + i] = f[i * 2];
  }
  return { out, peak };
}
function bandShare(x, sr, hz) { // Energieanteil oberhalb hz (einfache DFT über Stichproben-Frequenzen)
  let hi = 0, tot = 0;
  for (let f = 20; f < sr / 2; f *= 1.06) {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i += 1) { const w = 2 * Math.PI * f * i / sr; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); }
    const p = (re * re + im * im) * f; tot += p; if (f > hz) hi += p;
  }
  return hi / tot;
}

test('alle Profile: kein NaN, kein Übersteuern, kaum Energie über 2 kHz (nichts Schrilles)', () => {
  for (const id of Profiles.ids) {
    const r = drive(id, 24000, 5, (t) => t < 1 ? { rpm: 800, load: 0.05, speed: 0 } : { rpm: 1200 + 3500 * (t - 1) / 4, load: 1, speed: 30 + 60 * t / 5 });
    assert.ok(r.out.every((v) => v === v), id + ': NaN');
    assert.ok(r.peak <= 1 && r.peak > 0.05, id + ': Spitze ' + r.peak);
    const share = bandShare(r.out.subarray(r.out.length - 4800), 24000, 2000);
    assert.ok(share < 0.08, id + ': ' + (share * 100).toFixed(1) + ' % über 2 kHz');
  }
});

test('Verbrenner: Grundton = Zündfrequenz der virtuellen Drehzahl (Profil-Abbildung)', () => {
  const s = new Synth(24000);
  s.configure({ profile: 'supra', carIdle: 800, carRedline: 4800 });
  s._setProfile('supra');
  const p = Profiles.get('supra');
  assert.strictEqual(s._virtualRpm(800), p.idleRpm);
  assert.strictEqual(s._virtualRpm(4800), p.maxRpm);
  assert.ok(p.maxRpm <= 6500, 'Drehzahlband nur leicht gestreckt');
  // Zündfrequenz eines Reihensechsers bei 3000 U/min = 150 Hz: dort deutlich mehr Energie als bei 1000 Hz
  const r = drive('supra', 24000, 1.2, () => ({ rpm: 800 + (3000 - 800) / (6500 - 800) * 4000, load: 0.8, speed: 80 }));
  const x = r.out.subarray(4800);
  const at = (f) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const w = 2 * Math.PI * f * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } return Math.hypot(re, im); };
  assert.ok(at(150) > 5 * at(1000), 'Zündfrequenz dominiert: ' + at(150).toFixed(1) + ' vs ' + at(1000).toFixed(1));
});

test('Schub leiser als Last, ohne Übersteuern', () => {
  const r = drive('v8', 24000, 9, (t) => t < 6 ? { rpm: 1100 + 3700 * t / 6, load: 1, speed: 80 } : { rpm: 4800 - 3200 * (t - 6) / 3, load: 0, overrun: true, speed: 90 });
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const wot = rms(r.out.subarray(24000 * 3, 24000 * 6)), ovr = rms(r.out.subarray(24000 * 6.3));
  assert.ok(ovr < wot * 0.7 && ovr > wot * 0.1, 'Schub ' + ovr.toFixed(3) + ' vs Last ' + wot.toFixed(3));
  assert.ok(r.peak <= 1);
});

test('keine Knackser: niedrige Drehzahl unter Last, Schaltknicke, Gas weg (Spitzenfaktor im Hochpass)', () => {
  for (const id of Profiles.ids.filter((i) => Profiles.get(i).kind !== 'electric')) {
    const r = drive(id, 24000, 6, (t) => {
      if (t < 4) { const g = t % 1; return { rpm: 1300 + 800 * g, load: g < 0.22 ? 0.25 : 1, speed: 50 }; }
      return { rpm: 2600, load: t < 4.05 ? 1 : 0, overrun: t > 4.05, speed: 80 };
    });
    // Hochpass über die ganze Fahrt (Filter eingeschwungen), Spitze/RMS je 50 ms ab 0,5 s
    const hp = new Synth.Biquad().set('hp', 1000, 0.7, 24000), y = r.out.map((v) => hp.run(v));
    let worst = 0;
    for (let w = 12000; w + 1200 <= y.length; w += 1200) {
      let pk = 0, ss = 0;
      for (let i = w; i < w + 1200; i++) { ss += y[i] * y[i]; if (Math.abs(y[i]) > pk) pk = Math.abs(y[i]); }
      const rms = Math.sqrt(ss / 1200);
      if (rms > 1e-5) worst = Math.max(worst, pk / rms);
    }
    assert.ok(worst < 8, id + ': Spitzenfaktor ' + worst.toFixed(1) + ' (Knackser?)');
  }
});

test('keine Patscher, kein Mechanik-Klicken, kein Turbo- oder Ansaugrauschen, kein Zischen', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/synth.js'), 'utf8');
  assert.ok(!/popRate|popHeat|fBov|mechEnv|turboGain|fTurbo|inGain|fHelm|fHiss|hissT|HISS_AMT/.test(src));
  assert.ok(Profiles.list.every((p) => p.popRate === undefined && p.turbo === undefined && p.intake === undefined && p.bov === undefined));
});

test('Rauschen nur als Hauch: mindestens 36 dB unter dem Motorton', () => {
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  for (const id of Profiles.ids.filter((i) => Profiles.get(i).kind !== 'electric')) {
    const p = Profiles.get(id), rasp = p.rasp, fn = (t) => ({ rpm: 1100 + 3500 * t / 4, load: 1, speed: 60 });
    const full = drive(id, 24000, 4, fn).out;
    p.rasp = 0; const clean = drive(id, 24000, 4, fn).out; p.rasp = rasp;
    const db = 20 * Math.log10(rms(full.map((v, i) => v - clean[i])) / rms(clean));
    assert.ok(db < -36, id + ': Rauschen ' + db.toFixed(1) + ' dB');
  }
});

test('Rechenzeit bei 24 kHz im Rahmen (Head Unit)', () => {
  const s = new Synth(24000); s.configure({ profile: 'v10', volume: 1 }); s._setProfile('v10');
  const f = new Float32Array(960), t0 = process.hrtime.bigint();
  for (let k = 0; k < 250; k++) { s.setParams({ rpm: 1000 + (k % 50) * 76, load: 0.8, speed: 80 }); s.render(f, 480); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 40, ms.toFixed(1) + ' ms pro Sekunde Audio');
});

test('Dienst rendert für einen 24-kHz-Mono-Kanal halb so viele Frames mit 2 Byte', () => {
  const eng = new E.Engine({ log() {} });
  const writes = [];
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    write(b) { writes.push(b.length); return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  eng.t0 = Date.now() - 100; eng.written = 0;
  eng._tick();
  const bytes = writes.reduce((a, b) => a + b, 0);
  assert.ok(eng.written % 2 === 0 && eng.written > 0);
  assert.strictEqual(bytes, eng.written / 2 * 2);
  assert.strictEqual(eng.status().wants, true);
});

test('Regelkreis mit Rückmeldung des Players: Vorlauf begrenzt (Start 100 ms), auch wenn der Kanal hängt', () => {
  const eng = new E.Engine({ log() {} });
  let bytes = 0;
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    played: 0, write(b) { bytes += b.length; return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  eng.t0 = Date.now() - 5000; eng.written = 0;
  for (let i = 0; i < 20; i++) eng._tick();               // Kanal spielt nichts ab (z. B. noch nicht verbunden)
  const queuedMs = (bytes / 2) / 24000 * 1000;
  assert.ok(queuedMs <= E.FB_LEAD_START + 1 && queuedMs > 50, 'Warteschlange ' + queuedMs.toFixed(0) + ' ms');
  eng.out.played = bytes / 2;                                // alles gespielt -> genau ein Vorlauf wird nachgelegt
  const before = bytes; eng._tick();
  assert.ok(Math.abs((bytes - before) / 2 / 24 - E.FB_LEAD_START) < 2, 'nachgelegt ' + ((bytes - before) / 48).toFixed(0) + ' ms');
});

test('Lautstärke: sanftere Kurve und Kompressor heben Konstantfahrt an, Vollgas übersteuert nicht', () => {
  const lvl = (vol, load) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: vol, enabled: true }); s._setProfile('turbo4');
    const f = new Float32Array(4800); let pk = 0, sum = 0, n = 0;
    for (let k = 0; k < 60; k++) { s.setParams({ rpm: 2200, load, speed: 80 }); s.render(f, 2400); if (k > 30) for (let i = 0; i < 4800; i += 2) { const v = Math.abs(f[i]); pk = Math.max(pk, v); sum += v * v; n++; } }
    return { pk, rms: Math.sqrt(sum / n) }; };
  const cruise = lvl(0.6, 0.15), full = lvl(1, 1);
  assert.ok(cruise.rms > 0.03, 'Konstantfahrt bei 60 %: RMS ' + cruise.rms.toFixed(3));
  assert.ok(full.pk <= 1, 'Vollgas: Spitze ' + full.pk.toFixed(2));
});

test('Runterschalten: Zwischengas (Drehzahl springt hoch, Moment negativ) klingt nach Gasstoß, nicht nach Schub', () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const feed = new VehicleFeed(null, { info() {}, warn() {} }, () => ({ loadSource: 'auto', maxTorque: 400, carIdle: 800 }));
  const out = [];
  feed.on('sample', (x) => out.push(x));
  const realNow = Date.now;
  let t = 1e12;
  Date.now = () => t;
  try {
    feed.v.torque = -20; feed.v.torqueAt = t; feed.v.speed = 60; feed.v.speedAt = t;
    for (let i = 0; i < 10; i++) { t += 50; feed.v.rpm = 1800; feed.v.torqueAt = t; feed._sample(); }   // Schub
    assert.ok(out[out.length - 1].overrun, 'vorher Schub');
    for (let i = 0; i < 6; i++) { t += 50; feed.v.rpm = 1800 + 200 * (i + 1); feed.v.torqueAt = t; feed._sample(); } // Zwischengas
    const blip = out[out.length - 1];
    assert.ok(!blip.overrun && blip.load > 0.2, 'beim Zwischengas: overrun ' + blip.overrun + ', Last ' + blip.load.toFixed(2));
    for (let i = 0; i < 12; i++) { t += 50; feed.v.rpm = 3000; feed.v.torqueAt = t; feed._sample(); }   // wieder Schub
    assert.ok(out[out.length - 1].overrun, 'danach wieder Schub');
  } finally { Date.now = realNow; }
});

test('Autostart: App hat einen Hintergrund-Einstieg (background) und app.json autostart', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/background\(bg\)\s*\{\s*return startCore\(bg\)/.test(src));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8')).autostart, true);
});

test('Vorlauf: Start 100 ms, Aussetzer +30 ms, ruhig wieder knapper bis 50 ms', () => {
  const eng = new E.Engine({ log() {} });
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    played: 0, underruns: 0, write() { return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  const realNow = Date.now; let t = realNow();
  Date.now = () => t;
  try {
    eng._tick();
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START);
    eng.out.underruns = 1; eng.lastParams = t; eng._tick();
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START + 30);
    for (let i = 0; i < 40; i++) { t += 11000; eng.lastParams = t; eng._tick(); }
    assert.strictEqual(eng.fbLead, E.FB_LEAD_MS);
  } finally { Date.now = realNow; }
});

test('Player: Stille-Schutz gegen Leerlaufen und Stille zu Beginn (alsa_play.py)', () => {
  const py = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/alsa_play.py'), 'utf8');
  assert.ok(/select\.select\(\[fd\]/.test(py) && /snd_pcm_writei\(h, zeros, fill_n\)/.test(py));
  assert.ok(/os\.write\(1, \('P %d/.test(py), 'Rückmeldung der gespielten Frames');
});

test('Absenken: Telefon senkt ab, Navigation und Musik nicht, wieder laut wenn weg', async () => {
  const sources = [{ sourceID: 1048, name: 'OAPGenericOverlay' }, { sourceID: 10, name: 'Tuner_FM' }, { sourceID: 40, name: 'TEL_HandsFree' },
    { sourceID: 41, name: 'Navigation_Prompt' }, { sourceID: 12, name: 'USB_Media' }];
  const { am, signals } = fakeAm({ sources, conns: [{ mainConnectionID: 3, sourceID: 10, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step(); await r._pollDuck();
  assert.strictEqual(r.ducked, false, 'Radio allein: nicht absenken');
  am.conns.push({ mainConnectionID: 4, sourceID: 40, sinkID: 1, connectionState: 2 });
  await r._pollDuck();
  assert.strictEqual(r.ducked, true);
  assert.ok(/TEL_HandsFree/.test(r.duckBy));
  am.conns = am.conns.filter((c) => c.sourceID !== 40);
  am.conns.push({ mainConnectionID: 5, sourceID: 41, sinkID: 1, connectionState: 2 }); // Navi-Ansage: Ton bleibt
  await r._pollDuck();
  assert.strictEqual(r.ducked, false, 'Navigation darf nicht absenken');
  r.setDuck(false); am.conns.push({ mainConnectionID: 6, sourceID: 40, sinkID: 1, connectionState: 2 });
  r.lastDuck = 0; await r._step();
  assert.strictEqual(r.ducked, false, 'Einstellung aus: nie absenken');
  assert.ok(CarRoute.duckName('Phone') && CarRoute.duckName('PDC_Warning') && !CarRoute.duckName('CarLifeMedia') && !CarRoute.duckName('Radio_DAB'));
  assert.ok(!CarRoute.duckName('Navigation_Prompt') && !CarRoute.duckName('NaviGuidance') && !CarRoute.duckName('TTS') && !CarRoute.duckName('TrafficAnnouncement'));
});

test('Absenken im Klang: rund -12 dB', () => {
  const run = (duck) => { const s = new Synth(24000); s.configure({ profile: 'supra', volume: 0.8, enabled: true, duck }); s._setProfile('supra');
    const f = new Float32Array(4800); let sum = 0, n = 0;
    for (let k = 0; k < 50; k++) { s.setParams({ rpm: 2500, load: 0.4, speed: 80 }); s.render(f, 2400); if (k > 25) for (let i = 0; i < 4800; i += 2) { sum += f[i] * f[i]; n++; } }
    return Math.sqrt(sum / n); };
  const db = 20 * Math.log10(run(true) / run(false));
  assert.ok(db < -9 && db > -15, 'abgesenkt um ' + db.toFixed(1) + ' dB');
});

test('Einstellungen: Telefon/Ansagen-Option, Experten- und Motor-Gruppe, Gerät nur bei Tonweg 7', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const by = Object.fromEntries(j.settings.map((x) => [x.key, x]));
  assert.strictEqual(by.duck.default, true);
  assert.strictEqual(by.route.group, 'Experten');
  assert.deepStrictEqual(by.alsaDevice.when, { route: 'alsa' });
  assert.strictEqual(by.carRedline.group, 'Motor anpassen');
  assert.ok(!by.dialVolume);
});

test('Profile: Turbo-Auswahl (Standard Turbo Vierzylinder), kein Sechser/Dezent/Elektro mehr', () => {
  assert.strictEqual(Profiles.DEFAULT, 'turbo4');
  assert.deepStrictEqual(Profiles.ids, ['turbo4', 'turbo4s', 'supra', 'turbo5', 'boxer', 'v8', 'v10']);
  assert.strictEqual(Profiles.get('subtle').id, 'turbo4', 'alte gespeicherte Auswahl fällt auf den Standard zurück');
  assert.ok(Profiles.list.every((p) => p.kind === 'combustion' && p.desc));
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const opt = j.settings.find((x) => x.key === 'profile');
  assert.deepStrictEqual(opt.options.map((o) => o[0]), Profiles.ids);
  assert.strictEqual(opt.default, 'turbo4');
  assert.strictEqual(j.title, 'Sound Drive');
});

test('Gaswegnehmen nach Vollgas: in keinem Profil ein Zischen (keine Höhen-Spitze nach dem Lastwechsel)', () => {
  // Anteil über 1,5 kHz direkt nach dem Gaswegnehmen darf nicht höher sein als unter Last davor
  const hiRms = (x, a, b) => { let y = 0, p = 0, e = 0; const k = Math.exp(-2 * Math.PI * 1500 / 24000);
    for (let i = a - 2400; i < b; i++) { y = k * (y + x[i] - p); p = x[i]; if (i >= a) e += y * y; } return Math.sqrt(e / (b - a)); };
  for (const id of Profiles.ids) {
    const out = drive(id, 24000, 5, (t) => t < 3 ? { rpm: 2000 + 1500 * t / 3, load: 1, speed: 80 } : { rpm: 3500 - 400 * (t - 3), load: 0, overrun: true, speed: 80 }).out;
    const before = hiRms(out, 24000 * 2.5, 24000 * 3), after = hiRms(out, 24000 * 3.02, 24000 * 3.5);
    assert.ok(after <= before * 1.05 + 1e-4, id + ': Höhen nach Gas weg ' + after.toFixed(4) + ' vs unter Last ' + before.toFixed(4));
  }
});

test('Bei hoher Drehzahl lauter als bei niedriger (gleiche Last)', () => {
  const rms = (a) => Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length);
  const lo = rms(drive('turbo4', 24000, 2, () => ({ rpm: 1600, load: 0.3, speed: 60 })).out.subarray(24000));
  const hi = rms(drive('turbo4', 24000, 2, () => ({ rpm: 4200, load: 0.3, speed: 60 })).out.subarray(24000));
  assert.ok(hi > lo * 1.25, 'hoch ' + hi.toFixed(3) + ' vs niedrig ' + lo.toFixed(3));
});

test('Drehrad bleibt beim Auto: Kit hält den Controller nicht (MGU_NO_GRAB), App greift nicht zu', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/^process\.env\.MGU_NO_GRAB = '1';/m.test(src));
  assert.ok(!/controller\.grab\(true\)|controller\.onInput\(/.test(src));
});

test('Oberfläche: alles Bedienbare links von x = 1140 (geteilte Ansicht verdeckt rechts)', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const all = UI.hits(Profiles.list).concat(UI.hitsDiag());
  all.forEach((h) => assert.ok(h.x + h.w <= 1140, h.key + ' reicht bis ' + (h.x + h.w)));
});

test('Oberfläche: Profil-Knöpfe zwei je Reihe und groß genug für die Fahrt', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const chips = UI.hits(Profiles.list).filter((h) => h.act === 'profile');
  assert.strictEqual(new Set(chips.slice(0, 2).map((c) => c.y)).size, 1, 'erste Reihe: zwei Knöpfe');
  assert.ok(chips[2].y > chips[0].y, 'dritter Knopf in der nächsten Reihe');
  chips.forEach((c) => assert.ok(c.w >= 300 && c.h >= 60, c.key + ' ' + c.w + 'x' + c.h));
  UI.hits(Profiles.list).filter((h) => h.act === 'vol').forEach((h) => assert.ok(h.w >= 60 && h.h >= 60));
});

test('Lautstärke: 100 % klingt wie früher 150 %', () => {
  const run = (vol) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: vol, enabled: true }); s._setProfile('turbo4');
    const f = new Float32Array(4800); let sum = 0, n = 0;
    for (let k = 0; k < 50; k++) { s.setParams({ rpm: 2200, load: 0.15, speed: 80 }); s.render(f, 2400); if (k > 25) for (let i = 0; i < 4800; i += 2) { sum += f[i] * f[i]; n++; } }
    return Math.sqrt(sum / n); };
  const v100 = run(1), v66 = run(2 / 3);
  assert.ok(Math.abs(20 * Math.log10(v100 / v66)) > 1.5, 'über 66 % (= früher 100 %) noch lauter');
  assert.ok(v66 > 0.05, 'früher 100 % jetzt bei 66 %: ' + v66.toFixed(3));
});

test('Fahrmodus: Schalter-Werte werden erkannt, Eco leiser und dumpfer, Sport lauter und offener', () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const M = VehicleFeed.driveModeOf;
  assert.strictEqual(M(2), 'sport'); assert.strictEqual(M(28), 'sport'); assert.strictEqual(M(8), 'eco'); assert.strictEqual(M(5), 'comfort');
  assert.strictEqual(M(10), 'comfort'); assert.strictEqual(M(19), 'comfort'); assert.strictEqual(M('SPORT_PLUS'), 'sportplus');
  assert.strictEqual(M('ECO_PRO'), 'eco'); assert.strictEqual(M(''), null); assert.strictEqual(M(undefined), null);
  const run = (mode) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: 0.8, enabled: true, mode }); s._setProfile('turbo4');
    const f = new Float32Array(480); let sum = 0, n = 0;
    for (let k = 0; k < 400; k++) { s.setParams({ rpm: 2500, load: 0.4, speed: 80 }); s.render(f, 240); if (k > 250) for (let i = 0; i < 480; i += 2) { sum += f[i] * f[i]; n++; } }
    return Math.sqrt(sum / n); };
  const eco = run('eco'), com = run('comfort'), sp = run('sport'), none = run(null);
  assert.ok(eco < com * 0.8, 'Eco leiser: ' + eco.toFixed(3) + ' vs ' + com.toFixed(3));
  assert.ok(sp > com * 1.12, 'Sport lauter: ' + sp.toFixed(3) + ' vs ' + com.toFixed(3));
  assert.ok(Math.abs(none - com) < 1e-6, 'ohne Fahrmodus wie Comfort');
});

test('Fahrmodus-Wechsel mitten im Ton: weich, ohne Knacken', () => {
  const s = new Synth(24000); s.configure({ profile: 'supra', volume: 1, enabled: true, mode: 'eco' }); s._setProfile('supra');
  const f = new Float32Array(480), out = [];
  for (let k = 0; k < 300; k++) { if (k === 150) s.configure({ mode: 'sportplus' }); s.setParams({ rpm: 3000, load: 0.6, speed: 90 }); s.render(f, 240); for (let i = 0; i < 480; i += 2) out.push(f[i]); }
  let maxStep = 0; for (let i = 24000 * 1.4; i < 24000 * 1.7; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  let ref = 0; for (let i = 24000 * 1.0; i < 24000 * 1.3; i++) ref = Math.max(ref, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep < ref * 2.5, 'Sprung ' + maxStep.toFixed(3) + ' vs vorher ' + ref.toFixed(3));
});

test('Breite Ansicht: Knöpfe nutzen die ganze Breite, schmale bleibt links von 1140', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const wide = UI.hits(Profiles.list, true), narrow = UI.hits(Profiles.list, false);
  assert.ok(Math.max(...wide.map((h) => h.x + h.w)) > 1500 && Math.max(...wide.map((h) => h.x + h.w)) <= 1588);
  assert.ok(Math.max(...narrow.map((h) => h.x + h.w)) <= 1140);
  assert.ok(UI.hitAt(Profiles.list, 1500, 110, false, true), 'Tippen rechts trifft in breiter Ansicht');
  assert.ok(!UI.hitAt(Profiles.list, 1500, 110, false, false), 'in schmaler Ansicht nicht');
});

test('Oberfläche in allen Zuständen: nichts ragt über den Rand, keine leeren Texte', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const long = 'Overlay-Mix: verbunden · leiser (Telefon/PDC) · SmartX · 24 kHz · spielt · 12 Aussetzer';
  const states = [];
  for (const wide of [false, true]) for (const mode of [null, 'eco', 'sport', 'sportplus']) for (const enabled of [true, false])
    for (const diag of [null, { lines: Array.from({ length: 30 }, (_, i) => 'Zeile ' + i + ' ' + 'x'.repeat(90)), page: 1 }])
      states.push({ profiles: Profiles.list, profile: 'turbo5', rpm: 7000, redline: 4800, speed: 250, volume: 1, enabled, sport: true, demo: true, mode, wide, diag, audio: { ok: false, text: long } });
  for (const st of states) {
    const limit = st.wide ? 1600 : 1140;
    const g = { rect() {}, rrect() {}, line() {}, arc() {}, text(t, x, y, size, col, align) {
      assert.ok(t !== undefined && t !== null && String(t) !== 'undefined', 'Text undefined');
      const w = String(t).length * size * 0.5, x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      assert.ok(x0 >= 0 && x0 + w <= limit + 4, 'Text ragt hinaus: ' + JSON.stringify(String(t).slice(0, 40)) + ' bis ' + Math.round(x0 + w) + ' (Grenze ' + limit + ')');
      assert.ok(y > 0 && y <= 520, 'Text außerhalb der Höhe: ' + t);
    } };
    UI.draw(g, st);
  }
});

function levelAt(cfg, params, secs) {
  const s = new Synth(24000); s.configure(Object.assign({ profile: 'turbo4', volume: 0.8, enabled: true }, cfg)); s._setProfile(cfg.profile || 'turbo4');
  const f = new Float32Array(480); let sum = 0, n = 0; const N = Math.round((secs || 3) * 100);
  for (let k = 0; k < N; k++) { s.setParams(params); s.render(f, 240); if (k > N / 2) for (let i = 0; i < 480; i += 2) { sum += f[i] * f[i]; n++; } }
  return Math.sqrt(sum / n);
}

test('Tempo-Lautstärke: bei 130 km/h um die eingestellten dB lauter, in der Stadt gleich, abschaltbar', () => {
  const p = (v) => ({ rpm: 2200, load: 0.3, speed: v });
  const db = (a, b) => 20 * Math.log10(a / b);
  const city4 = levelAt({ speedVol: 4 }, p(40)), city0 = levelAt({ speedVol: 0 }, p(40));
  // bei 50 % Lautstärke (oben begrenzt der Begrenzer, dann wirkt die Anhebung schwächer)
  const hwy4 = levelAt({ speedVol: 4, volume: 0.5 }, p(135)), hwy0 = levelAt({ speedVol: 0, volume: 0.5 }, p(135)), hwy6 = levelAt({ speedVol: 6, volume: 0.5 }, p(135));
  assert.ok(Math.abs(db(city4, city0)) < 0.2, 'Stadt unverändert: ' + db(city4, city0).toFixed(2) + ' dB');
  assert.ok(Math.abs(db(hwy4, hwy0) - 4) < 0.8, 'Autobahn +4 dB: ' + db(hwy4, hwy0).toFixed(2));
  assert.ok(db(hwy6, hwy4) > 1.2, 'Stark lauter als Mittel');
});

test('Startsound: Motor aus -> an spielt Anlassen, Hochdrehen, Leerlauf; aus = kein Ablauf', () => {
  const run = (startSound) => { const s = new Synth(24000); s.configure({ profile: 'supra', volume: 0.8, enabled: true, startSound }); s._setProfile('supra');
    const f = new Float32Array(480); let maxRpm = 0, pk = 0, crank = 0;
    for (let k = 0; k < 400; k++) { const t = k / 100; s.setParams({ rpm: t < 1 ? 0 : 820, load: 0.04, speed: 0 }); pk = Math.max(pk, s.render(f, 240));
      if (t > 1 && t < 4) maxRpm = Math.max(maxRpm, s.rpm); if (t > 1.05 && t < 1.2) crank = Math.max(crank, s.rpm); }
    return { maxRpm, pk, crank, endRpm: s.rpm }; };
  const on = run(true), off = run(false), idle = Profiles.get('supra').idleRpm;
  assert.ok(on.maxRpm > idle * 1.2 && on.maxRpm < idle * 1.6, 'kurzes Hochdrehen: ' + Math.round(on.maxRpm));
  assert.ok(on.crank < 320, 'Anlassen mit Starterdrehzahl: ' + Math.round(on.crank));
  assert.ok(Math.abs(on.endRpm - idle) < 60, 'danach Leerlauf: ' + Math.round(on.endRpm));
  assert.ok(off.maxRpm < idle * 1.15, 'ohne Startsound kein Hochdrehen: ' + Math.round(off.maxRpm));
  assert.ok(on.pk <= 1);
  // läuft der Motor schon, wenn die App startet: kein Startsound
  const s = new Synth(24000); s.configure({ profile: 'supra', volume: 0.8, enabled: true }); s._setProfile('supra');
  const f = new Float32Array(480); let mx = 0;
  for (let k = 0; k < 200; k++) { s.setParams({ rpm: 820, load: 0.04, speed: 0 }); s.render(f, 240); mx = Math.max(mx, s.rpm); }
  assert.ok(mx < idle * 1.15, 'Motor lief schon: kein Startsound');
});

test('Klang-Regler: Bass und Bellen wirken', () => {
  // Bass: Verhältnis 20–140 Hz zu 140–600 Hz (Frequenzanalyse). Der Kompressor hält die Gesamtlautstärke,
  // das Verhältnis Bass/Mitten verschiebt sich – das hört man als mehr oder weniger Bass.
  const lowShare = (cfg) => { const s = new Synth(24000); s.configure(Object.assign({ profile: 'turbo4', volume: 0.5, enabled: true }, cfg)); s._setProfile('turbo4');
    const f = new Float32Array(480), x = [];
    for (let q = 0; q < 300; q++) { s.setParams({ rpm: 1800, load: 0.5, speed: 80 }); s.render(f, 240); if (q > 150) for (let i = 0; i < 480; i += 2) x.push(f[i]); }
    const band = (lo, hi) => { let en = 0; for (let fr = lo; fr < hi; fr += 5) { let re = 0, im = 0; for (let i = 0; i < x.length; i += 2) { const w = 2 * Math.PI * fr * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } en += re * re + im * im; } return en; };
    return band(20, 140) / band(140, 600); };
  const lb = lowShare({}), lp6 = lowShare({ bassDb: 6 }), lm6 = lowShare({ bassDb: -6 });
  assert.ok(lp6 > lb * 1.8 && lm6 < lb * 0.55, 'Bass/Mitten: ' + lm6.toFixed(2) + ' < ' + lb.toFixed(2) + ' < ' + lp6.toFixed(2));
  // Bellen: Anteil 250–1200 Hz gegenüber 40–250 Hz steigt deutlich
  const midShare = (cfg) => { const s = new Synth(24000); s.configure(Object.assign({ profile: 'turbo4', volume: 0.4, enabled: true }, cfg)); s._setProfile('turbo4');
    const f = new Float32Array(480), x = [];
    for (let q = 0; q < 300; q++) { s.setParams({ rpm: 3200, load: 0.8, speed: 90 }); s.render(f, 240); if (q > 150) for (let i = 0; i < 480; i += 2) x.push(f[i]); }
    const band = (lo, hi, st) => { let en = 0; for (let fr = lo; fr < hi; fr += st) { let re = 0, im = 0; for (let i = 0; i < x.length; i += 2) { const w = 2 * Math.PI * fr * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } en += re * re + im * im; } return en; };
    return band(250, 1200, 6) / band(40, 250, 4); };
  const m50 = midShare({ barkPct: 0.5 }), m150 = midShare({ barkPct: 1.5 });
  assert.ok(m150 > m50 * 1.6, 'Bellen 50 % ' + m50.toFixed(3) + ' vs 150 % ' + m150.toFixed(3));
});

test('Einstellungen der neuen Funktionen vorhanden', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const by = Object.fromEntries(j.settings.map((x) => [x.key, x]));
  assert.strictEqual(by.speedVol.default, 4); assert.strictEqual(by.startSound.default, true);
  ['bassDb', 'bark'].forEach((k) => assert.strictEqual(by[k].group, 'Klang anpassen'));
  assert.ok(!by.hiss, 'kein Zischen-Regler mehr');
});

test('Lautstärkeknopf: Drehen gibt den Knopf der Musik (Motorsound stumm, Verbindung frei), nach Ruhe zurück', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  const changes = [];
  r.onChange = (a) => changes.push(a);
  r.want('overlay', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.ok(r.audible(), 'verbunden + CS_CONNECTED = hörbar');
  await r._knobTick();                       // Ausgangswert lesen
  am.vol = 23;                               // Knopf gedreht
  await r._knobTick();
  assert.ok(r.knobHeld(), 'Knopf gedreht erkannt');
  assert.ok(!r.audible(), 'Motorsound stumm');
  assert.ok(changes.includes(false));
  await r._step();
  assert.strictEqual(am.conns.length, 0, 'Verbindung freigegeben -> Knopf regelt wieder die Musik');
  assert.ok(/Pause/.test(r.state));
  am.vol = 25; await r._knobTick();          // weiter gedreht: bleibt frei
  await r._step();
  assert.strictEqual(am.conns.length, 0);
  r.knobAt = Date.now() - 2000;              // 2 s Ruhe
  await r._step();
  assert.strictEqual(am.conns.length, 1, 'nach Ruhe wieder verbunden');
  assert.ok(r.audible());
  // Einstellung aus: Drehen ändert nichts (Knopf regelt dann den Motorsound, wie im Auto vorgesehen)
  r.setKnob(false); am.vol = 30; await r._knobTick(); await r._step();
  assert.ok(!r.knobHeld() && am.conns.length === 1);
});

test('Hörbar erst ab CS_CONNECTED (Auto braucht ~6 s); verlorene Verbindung sofort stumm', async () => {
  const { am, signals } = fakeAm({ state: 1 });  // CS_CONNECTING
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step();
  assert.ok(r.conn && !r.audible(), 'verbindet noch: stumm');
  am.conns.forEach((c) => { c.connectionState = 2; });
  r.lastVerify = 0; await r._step();
  assert.ok(r.audible(), 'jetzt verbunden: hörbar');
  am.conns = [];                              // CarPlay-Navi übernimmt den Overlay-Platz
  await r._pollDuck();
  assert.ok(!r.conn && !r.audible(), 'Verbindung weg -> stumm, bis neu verbunden');
  await r._step();
  assert.ok(r.conn, 'gleich neu verbunden (kurze Wartezeit)');
  // ohne CS_CONNECTED-Meldung: spätestens nach AUDIBLE_AFTER_MS hörbar
  const r2 = new CarRoute(fakeAm({ state: 1 }).signals, quiet, null);
  r2.want('overlay', true); await r2._step();
  r2.conn.at = Date.now() - CarRoute.AUDIBLE_AFTER_MS - 10;
  assert.ok(r2.audible());
  // Wege ohne Audiomanager sind immer hörbar
  const r3 = new CarRoute(fakeAm().signals, quiet, null); r3.want('carplay', true);
  assert.ok(r3.audible());
});

test('Synth: hold blendet weich aus und wieder ein, ohne Knacken', () => {
  const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: 0.8, enabled: true }); s._setProfile('turbo4');
  const f = new Float32Array(480), out = [];
  for (let k = 0; k < 300; k++) { if (k === 100) s.configure({ hold: true }); if (k === 200) s.configure({ hold: false });
    s.setParams({ rpm: 2500, load: 0.4, speed: 80 }); s.render(f, 240); for (let i = 0; i < 480; i += 2) out.push(f[i]); }
  let held = 0; for (let i = 24000 * 1.6; i < 24000 * 2; i++) held = Math.max(held, Math.abs(out[i]));
  let back = 0; for (let i = 24000 * 2.6; i < 24000 * 3; i++) back = Math.max(back, Math.abs(out[i]));
  assert.ok(held < 0.003 && back > 0.1, 'gehalten ' + held.toFixed(4) + ', zurück ' + back.toFixed(3));
  let step = 0; for (let i = 24000 * 0.95; i < 24000 * 1.3; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
  let ref = 0; for (let i = 24000 * 0.5; i < 24000 * 0.9; i++) ref = Math.max(ref, Math.abs(out[i] - out[i - 1]));
  assert.ok(step <= ref * 1.5, 'kein Sprung beim Ausblenden');
});

test('Motor aus: Drehzahl 0 kommt nur einmal – App sendet bis 2 min weiter, laufender Motor ohne Daten nicht', () => {
  const AudioLink = require(path.join(ROOT, 'apps/iconix_sounds/audio_link.js'));
  const l = new AudioLink(quiet, 'test');
  const sent = []; l.connected = true; l.send = (m) => { sent.push(m); return true; };
  const realNow = Date.now; let t = 1e12; Date.now = () => t;
  try {
    l.params({ rpm: 0, load: 0, speed: 0, overrun: false, at: t });
    t += 60000; l.lastSend = 0; l._tick();
    assert.ok(sent.length >= 2 && sent[sent.length - 1].rpm === 0, 'Motor aus: Lebenszeichen nach 60 s');
    t += 70000; const n = sent.length; l.lastSend = 0; l._tick();
    assert.strictEqual(sent.length, n, 'nach über 2 min nicht mehr');
    l.params({ rpm: 2500, load: 0.5, speed: 80, overrun: false, at: t });
    t += 3000; const m = sent.length; l.lastSend = 0; l._tick();
    assert.strictEqual(sent.length, m, 'laufender Motor ohne neue Daten: nicht weiter senden (sonst hinge der Ton)');
  } finally { Date.now = realNow; }
});

test('Oberfläche im Auto (Kit führt den Bildschirm): kein doppelter Titel, breite Ansicht ist Standard', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const texts = [];
  const g = { rect() {}, rrect() {}, line() {}, arc() {}, text(t) { texts.push(String(t)); } };
  UI.draw(g, { profiles: Profiles.list, profile: 'turbo4', rpm: 900, speed: 0, volume: 0.8, enabled: true, own: true, wide: true, audio: { ok: true, text: 'x' } });
  assert.ok(!texts.includes('Sound Drive'), 'Titel steht schon im Kopf des Kits');
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const by = Object.fromEntries(j.settings.map((x) => [x.key, x]));
  assert.strictEqual(by.wide.default, true);
  assert.strictEqual(by.knobMusic.default, true);
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/hideButton\('BTN_PROFILE'\)/.test(src), 'untere Leiste ohne "Sound wechseln"');
});

test('Dienst: Profilwechsel kurz vor dem Start des Players geht nicht verloren (24-kHz-Umbau)', () => {
  const eng = new E.Engine({ log() {} });
  eng.configure({ profile: 'turbo4', volume: 0.5, enabled: true });
  eng.synth._setProfile('turbo4'); eng.synth.pending = null;
  eng.configure({ profile: 'v10' });                 // App schickt die Einstellungen ...
  assert.strictEqual(eng.synth.pending, 'v10');
  eng._rebuildSynth(24000);                          // ... dann startet der Player (24-kHz-Kanal)
  assert.strictEqual(eng.synth.cfg.profile, 'v10');
  assert.strictEqual(eng.status().profile, 'v10');
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  }
  if (fail) { console.log(fail + ' Test(s) fehlgeschlagen'); process.exit(1); }
  console.log('Alle Iconix-Tonweg-Tests bestanden');
})();
