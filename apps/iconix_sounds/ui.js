/*
 * Sound Drive – Hauptbildschirm (1600 x 520) im Stil von BMW iDrive 7
 *
 * Aufbau: links "Sound Drive", darunter der Drehzahlmesser und der Status; rechts der aktive Sound, große
 * Profil-Knöpfe (zwei je Reihe, gut während der Fahrt zu treffen) und die Lautstärke.
 * Standard: alles links von x = 1140, denn mit geteilter Ansicht verdeckt das Seitenfenster von iDrive 7 den
 * rechten Teil der Seite. "Breite Ansicht" (ohne Seitenfenster) nutzt die ganze Breite.
 *
 * Gestaltung angelehnt an iDrive 7 und das digitale Kombiinstrument: dunkler, leicht blauer Grund,
 * dünne Linien, Light-Schrift für Zahlen und Titel, BMW-Blau als einzige Akzentfarbe, flache Kacheln
 * mit feinem Rand, Drehzahlmesser mit Skalenstrichen und rotem Bereich.
 *
 * Zeichnet über ein kleines Grafik-Interface `g`, damit derselbe Code im Auto (Kit-Canvas) und im
 * PC-Simulator (HTML-Canvas) läuft:
 *   g.rect(x, y, w, h, color)
 *   g.rrect(x, y, w, h, radius, color)
 *   g.line(x1, y1, x2, y2, width, color)
 *   g.text(str, x, baselineY, size, color, align /* 'left'|'center'|'right' *\/, weight /* true = fett, 'light' = dünn *\/)
 *   g.arc(cx, cy, radius, thickness, a0, a1, color)   // Winkel in Radiant, 0 = 3 Uhr, im Uhrzeigersinn
 *
 * Leistung: nur Rechtecke, Linien, Bögen und Text; keine Allokation pro Bild außer kurzen Strings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1600, H = 520;
  var C = {
    bg: '#06090e', bg2: '#0a0f17', panel: '#0f151e', edge: '#233041', track: '#1b2430', tick: '#4d5a6b',
    text: '#f2f5f8', dim: '#8d99aa', faint: '#5b6676',
    accent: '#1c69d4', accent2: '#5fa3ff', hi: '#2f7fe6',
    warn: '#ffb020', crit: '#e8332f', ok: '#3fbf7f'
  };
  var TX = 230, TY = 262, TR = 172;  // Drehzahlmesser: Mitte und Radius
  var A0 = Math.PI * 0.75, A1 = Math.PI * 2.25; // 135° .. 405° (270°-Skala wie im Kombiinstrument)

  function pct(x) { return Math.round(x * 100) + ' %'; }
  var MODE_TAG = { eco: ['ECO', '#3fbf7f'], sport: ['SPORT', '#5fa3ff'], sportplus: ['SPORT+', '#e8332f'] };

  // Geometrie der bedienbaren Flächen – EINE Quelle für Zeichnen, Touch-Ziele im Auto (cv.target)
  // und Klicks im Simulator.
  var X1_NARROW = 1132, X1_WIDE = 1572;
  var X0 = 488, X1 = X1_NARROW, COLS = 2, GAP = 16, CW = (X1 - X0 - GAP) / 2, CH = 72, RGAP = 10, CHIP_Y = 78;
  function setWide(wide) { X1 = wide ? X1_WIDE : X1_NARROW; CW = (X1 - X0 - GAP) / 2; }
  var VY = 430, VB = 66;           // Lautstärke-Zeile, Größe der −/+-Knöpfe
  function chipRect(i) {
    return { x: X0 + (i % COLS) * (CW + GAP), y: CHIP_Y + Math.floor(i / COLS) * (CH + RGAP), w: CW, h: CH, r: 8 };
  }
  /** Bedienbare Flächen: [{ key, act, arg, x, y, w, h, r }] – act: 'profile' | 'vol' */
  function hits(profiles, wide) {
    setWide(wide);
    var out = [], i, c;
    for (i = 0; i < profiles.length; i++) {
      c = chipRect(i);
      out.push({ key: 'profile:' + profiles[i].id, act: 'profile', arg: profiles[i].id, x: c.x, y: c.y, w: c.w, h: c.h, r: c.r });
    }
    out.push({ key: 'vol-', act: 'vol', arg: -1, x: X0, y: VY, w: VB, h: VB, r: 8 });
    out.push({ key: 'vol+', act: 'vol', arg: 1, x: X1 - VB, y: VY, w: VB, h: VB, r: 8 });
    return out;
  }
  // Diagnose-Ansicht: Geräte testen / Weiter / Schließen
  var DIAG_LINES = 12;
  function hitsDiag(wide) {
    if (wide !== undefined) setWide(wide);
    return [
      { key: 'diag-devtest', act: 'diagDevTest', arg: null, x: X1 - 640, y: 458, w: 220, h: 48, r: 6 },
      { key: 'diag-next', act: 'diagNext', arg: null, x: X1 - 408, y: 458, w: 190, h: 48, r: 6 },
      { key: 'diag-close', act: 'diagClose', arg: null, x: X1 - 206, y: 458, w: 206, h: 48, r: 6 }
    ];
  }
  function hitAt(profiles, x, y, diag, wide) {
    var h = diag ? hitsDiag(!!wide) : hits(profiles, !!wide);
    for (var i = 0; i < h.length; i++) if (x >= h[i].x && x <= h[i].x + h[i].w && y >= h[i].y && y <= h[i].y + h[i].h) return h[i];
    return null;
  }

  // Kachel mit feinem Rand (iDrive: flach, kleiner Radius)
  function tile(g, x, y, w, h, r, fill, edge) {
    g.rrect(x, y, w, h, r, edge);
    g.rrect(x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1.5), fill);
  }

  // Untertitel eines Profils (Bauart)
  function kindOf(p) {
    if (!p) return '';
    if (p.kind === 'electric') return 'Elektro';
    var n = p.layout ? p.layout.length : 0;
    var v = { v8: 'V8', v10: 'V10', boxer: 'Boxer · 4 Zylinder' }[p.id];
    return (v || (n ? n + ' Zylinder' : '')) + (p.bov || /turbo/.test(p.id) ? ' · Turbo' : '');
  }

  // Statuszeile auf höchstens zwei Zeilen à n Zeichen umbrechen (an " · ")
  function wrap2(t, n) {
    if (t.length <= n) return [t];
    var parts = t.split(' · '), a = '', i = 0;
    while (i < parts.length && (a ? a + ' · ' + parts[i] : parts[i]).length <= n) { a = a ? a + ' · ' + parts[i] : parts[i]; i++; }
    if (!a) return [t.slice(0, n), t.length > 2 * n ? t.slice(n, 2 * n - 1) + '…' : t.slice(n)];
    var b = parts.slice(i).join(' · ');
    return [a, b.length > n ? b.slice(0, n - 1) + '…' : b];
  }

  /**
   * state = {
   *   profiles: [{id, name, kind, layout}], profile: 'turbo4',
   *   rpm, redline, speed, volume (0..1),
   *   enabled, sport, demo,
   *   audio: { ok: bool, text: '…' }
   * }
   */
  function draw(g, s) {
    setWide(!!s.wide);
    g.rect(0, 0, W, H, C.bg);

    // ---- links: App-Name, Drehzahlmesser, Status --------------------------
    // Titel nur, wenn das Kit ihn nicht schon im Kopf zeigt (im Auto mit GPU-Renderer steht er dort)
    if (!s.own) g.text('Sound Drive', 28, 46, 30, C.text, 'left', 'light');
    // Marken neben dem Titel: Fahrmodus (dem der Sound folgt), Sport-Boost, Demo
    var tags = [], tx = s.own ? 28 : 216, m = MODE_TAG[s.mode];
    if (m) tags.push(m);
    if (s.sport) tags.push(['BOOST', C.accent2]);
    if (s.demo) tags.push(['DEMO', C.warn]);
    for (var t = 0; t < tags.length && tx < 440; t++) {
      var tw = tags[t][0].length * 12 + 26;
      tile(g, tx, 22, tw, 32, 16, C.bg, tags[t][1]);
      g.text(tags[t][0], tx + tw / 2, 45, 16, tags[t][1], 'center', true);
      tx += tw + 8;
    }
    drawTacho(g, s);
    var a = s.audio || { ok: false, text: 'Audio-Dienst nicht verbunden' };
    var ls = wrap2(a.text, 38);
    g.rrect(28, 470 - 13, 12, 12, 6, a.ok ? C.ok : C.crit);
    for (var j = 0; j < ls.length; j++) g.text(ls[j], 50, 470 - 1 + j * 28, 21, C.dim, 'left', 'light');

    if (s.diag) { drawDiag(g, s); return; }

    // ---- rechts: aktiver Sound, große Profil-Knöpfe, Lautstärke ----------
    var x0 = X0, x1 = X1, i, cur = null;
    for (i = 0; i < s.profiles.length; i++) if (s.profiles[i].id === s.profile) cur = s.profiles[i];
    g.text(cur ? cur.name : '–', x0, 50, 36, s.enabled ? C.text : C.dim, 'left', 'light');
    g.text(kindOf(cur), x1, 50, 20, C.faint, 'right', 'light');
    g.line(x0, 66, x1, 66, 1.5, C.edge);
    g.line(x0, 66, x0 + 96, 66, 3, C.accent);

    for (i = 0; i < s.profiles.length; i++) {
      var c = chipRect(i), active = s.profiles[i].id === s.profile;
      if (active) {
        g.rrect(c.x, c.y, c.w, c.h, c.r, C.accent);
        g.rect(c.x + 4, c.y + 2, c.w - 8, 2, C.hi); // Lichtkante oben
      } else tile(g, c.x, c.y, c.w, c.h, c.r, C.panel, C.edge);
      g.text(s.profiles[i].name, c.x + c.w / 2, c.y + c.h / 2 + 10, s.wide ? 30 : 26, active ? '#ffffff' : '#c3ccd7', 'center', active ? false : 'light');
    }

    // ---- Lautstärke: [−] ——●—— [+], Wert über dem Regler ------------------
    var vy = VY, by = vy + VB / 2;
    tile(g, x0, vy, VB, VB, 8, C.panel, C.edge);
    g.line(x0 + 20, by, x0 + VB - 20, by, 3.5, C.text);
    tile(g, x1 - VB, vy, VB, VB, 8, C.panel, C.edge);
    g.line(x1 - VB + 20, by, x1 - 20, by, 3.5, C.text);
    g.line(x1 - VB / 2, vy + 20, x1 - VB / 2, vy + VB - 20, 3.5, C.text);
    var bx = x0 + VB + 28, bw = x1 - x0 - 2 * (VB + 28);
    g.text('Lautstärke', bx, vy + 12, 20, C.dim, 'left', 'light');
    g.text(s.enabled ? pct(s.volume) : 'Stumm', bx + bw, vy + 12, 22, s.enabled ? C.text : C.warn, 'right', 'light');
    g.rrect(bx, by + 6, bw, 6, 3, C.track);
    var v = Math.max(0, Math.min(1, s.volume)), vx = bx + bw * v;
    if (v > 0.01) g.rrect(bx, by + 6, vx - bx, 6, 3, s.enabled ? C.accent : C.faint);
    g.rrect(vx - 12, by - 3, 24, 24, 12, s.enabled ? '#ffffff' : C.dim);
  }

  // Drehzahlmesser wie im Kombiinstrument: Skala mit Strichen und Ziffern, roter Bereich, blauer Bogen
  function drawTacho(g, s) {
    var cx = TX, cy = TY, r = TR;
    var redline = s.redline || 4800, top = Math.ceil(redline * 1.1 / 1000) * 1000;
    var rpm = Math.max(0, s.rpm || 0), frac = Math.min(1, rpm / top), redFrom = redline / top;
    var span = A1 - A0, k, ang, cs, sn, major, red;
    g.arc(cx, cy, r, 3, A0, A1, C.track);
    g.arc(cx, cy, r, 3, A0 + span * redFrom, A1, '#5a1c1f');
    // Striche alle 500 U/min, Ziffern (x1000) an den vollen Tausendern
    for (k = 0; k <= top; k += 500) {
      ang = A0 + span * (k / top); cs = Math.cos(ang); sn = Math.sin(ang);
      major = k % 1000 === 0; red = k >= redline;
      var r0 = r - (major ? 24 : 15), r1 = r - 6;
      g.line(cx + cs * r0, cy + sn * r0, cx + cs * r1, cy + sn * r1, major ? 3 : 2, red ? C.crit : (major ? '#c9d1db' : C.tick));
      if (major) g.text(String(k / 1000), cx + cs * (r - 46), cy + sn * (r - 46) + 8, 23, red ? C.crit : C.dim, 'center', 'light');
    }
    // Bogen bis zur aktuellen Drehzahl (blau, im roten Bereich rot) und schmale Nadel
    if (frac > 0.003) {
      var redA = A0 + span * Math.min(frac, redFrom);
      g.arc(cx, cy, r + 9, 8, A0, redA, s.sport ? C.accent2 : C.accent);
      if (frac > redFrom) g.arc(cx, cy, r + 9, 8, A0 + span * redFrom, A0 + span * frac, C.crit);
    }
    ang = A0 + span * frac; cs = Math.cos(ang); sn = Math.sin(ang);
    g.line(cx + cs * (r - 30), cy + sn * (r - 30), cx + cs * (r + 10), cy + sn * (r + 10), 4, frac > redFrom ? C.crit : "#ffffff"); // kurz: verdeckt die Ziffern nicht
    // Ziffern in der Mitte, Tempo unten in der Öffnung der Skala
    g.text(String(Math.round(rpm)), cx, cy + 20, 78, C.text, 'center', 'light');
    g.text('1/min', cx, cy + 54, 20, C.faint, 'center', 'light');
    g.text(Math.round(s.speed || 0) + ' km/h', cx, cy + 150, 30, C.text, 'center', 'light');
  }

  // s.diag = { lines: [...], page: 0 }
  function drawDiag(g, s) {
    var d = s.diag, pages = Math.max(1, Math.ceil(d.lines.length / DIAG_LINES));
    var page = ((d.page || 0) % pages + pages) % pages;
    tile(g, X0 - 20, 18, X1 - X0 + 40, 494, 8, C.panel, C.edge);
    g.text('Audio-Diagnose', X0, 60, 28, C.text, 'left', 'light');
    g.line(X0, 76, X1, 76, 1.5, C.edge);
    g.line(X0, 76, X0 + 96, 76, 3, C.accent);
    g.text('Seite ' + (page + 1) + '/' + pages, X1, 60, 20, C.dim, 'right', 'light');
    var ls = d.lines.slice(page * DIAG_LINES, page * DIAG_LINES + DIAG_LINES);
    ls = ls.map(function (l) { return l.length > 62 ? l.slice(0, 61) + '…' : l; });
    for (var i = 0; i < ls.length; i++) g.text(ls[i], X0, 106 + i * 28, 19, i === 0 && page === 0 ? C.text : C.dim, 'left', 'light');
    var b = hitsDiag();
    tile(g, b[0].x, b[0].y, b[0].w, b[0].h, b[0].r, C.bg2, C.edge);
    g.text('Geräte testen', b[0].x + b[0].w / 2, b[0].y + 32, 21, C.warn, 'center', 'light');
    tile(g, b[1].x, b[1].y, b[1].w, b[1].h, b[1].r, C.bg2, C.edge);
    g.text('Weiter', b[1].x + b[1].w / 2, b[1].y + 32, 21, C.text, 'center', 'light');
    g.rrect(b[2].x, b[2].y, b[2].w, b[2].h, b[2].r, C.accent);
    g.text('Schließen', b[2].x + b[2].w / 2, b[2].y + 32, 21, '#ffffff', 'center', false);
  }

  return { W: W, H: H, colors: C, draw: draw, hits: hits, hitsDiag: hitsDiag, hitAt: hitAt, DIAG_LINES: DIAG_LINES, X1_NARROW: X1_NARROW, X1_WIDE: X1_WIDE };
});
