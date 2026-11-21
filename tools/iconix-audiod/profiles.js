/*
 * Sound Drive – Sound-Profile (für synth.js Version 2)
 *
 * Gemeinsame Datei für App und Audio-Dienst (Node 8). Nur ES2017-Syntax.
 *
 * Verbrenner ("combustion"):
 *   layout       Zündereignisse [Kurbelwinkel im 720°-Zyklus, Bank 0/1] in Zündfolge
 *   displacement Hubraum in Litern (Impulsgröße, Klangfülle)
 *   idleRpm / maxRpm  virtueller Drehzahlbereich; echte Leerlauf- bis Abregeldrehzahl wird darauf
 *                abgebildet. Bewusst nur leicht gestreckt: zu hohe virtuelle Drehzahl = zu hoher Ton.
 *   blowdown     Vorauslass-Fenster in Grad (Benziner ~62): bestimmt die Impulsbreite
 *   flowExp      wie stark der Impuls mit der Drehzahl lauter wird (0.4 sanft … 1 physikalisch)
 *   headerM / headerRatio / headerSpread  Krümmerlänge (m), Verhältnis Bank 2, Streuung je Zylinder (m)
 *   pipeM / pipeFb / pipeLp   Hauptrohr: Länge (m), Reflexion am offenen Ende, Dämpfung (Hz)
 *   chamberM / chamberFb      Schalldämpferkammer
 *   mufflerHz / mufflerQ      Tiefpass des Schalldämpfers (öffnet mit Last etwas, wie eine Klappe)
 *   rasp        Rauschanteil im Impuls unter Last (nur ein Hauch Textur, sonst klingt es nach Rauschen)
 *   unev        Zylinder-Ungleichheit unter Last (Halbordnungen, "Brummen")
 *   variance    Zyklus-Streuung (Leerlauf-Lebendigkeit)
 *   cabinHz / boomHz / boomDb / midDb  Innenraum: Tiefpass, Dröhn-Anhebung, Mitten
 *   drive       weiche Sättigung
 *   exhaust / bark / vib / vibHz  Innenraum-Mischung: Auspuffanteil, dessen "Bellen" (Ableitung),
 *               Körperschall (tiefpassgefilterte Zündimpulse über Motorlager und Karosserie) und dessen Grenzfrequenz
 *   gain        Pegelabgleich zwischen den Profilen (mit kit/tools/iconix_calibrate.js ermittelt)
 *
 * Elektro ("electric"): baseHz, octaveKmh, voices [Verhältnis, Pegel, Verstimmung], sub, cutoff,
 *   cutoffPerKmh, lfoHz, lfoDepth, drive, gain.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixProfiles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Zündfolgen (Kurbelwinkel im 720°-Zyklus, Bank für die Krümmergruppe)
  var I6 = [[0, 0], [120, 1], [240, 0], [360, 1], [480, 0], [600, 1]];            // 1-5-3-6-2-4, Krümmer 1-3 / 4-6
  var I4 = [[0, 0], [180, 1], [360, 0], [540, 1]];                                // 1-3-4-2, 4-2-1-Krümmer
  var V8X = [[0, 0], [90, 1], [180, 1], [270, 0], [360, 1], [450, 0], [540, 0], [630, 1]]; // Cross-Plane 1-8-4-3-6-5-7-2
  var V10 = [[0, 0], [72, 1], [144, 0], [216, 1], [288, 0], [360, 1], [432, 0], [504, 1], [576, 0], [648, 1]];

  var I5 = [[0, 0], [144, 1], [288, 0], [432, 1], [576, 0]];                    // 1-2-4-5-3, 144° Abstand
  var B4 = [[0, 0], [180, 1], [360, 1], [540, 0]];                                // Boxer 1-3-2-4, ungleiche Krümmer je Seite

  var LIST = [
    {
      // Turbo-Vierzylinder: kernig und drehfreudig – der Maßstab für die übrigen Turbo-Profile
      id: 'turbo4', name: 'Turbo Vierzylinder', desc: 'Kernig und drehfreudig', kind: 'combustion',
      layout: I4, displacement: 2.0, idleRpm: 800, maxRpm: 6200, blowdown: 62, flowExp: 0.55,
      headerM: 0.7, headerRatio: 1.05, headerSpread: 0.06,
      pipeM: 3.0, pipeLp: 2400, chamberM: 0.36, mufflerHz: 1300, mufflerQ: 0.8,
      unev: 0.2, variance: 0.8,
      boomHz: 90, drive: 1.5, rasp: 0.015, pipeFb: 0.24, chamberFb: 0.22, cabinHz: 1800, boomDb: 4.5, midDb: -2.5, exhaust: 0.75, bark: 0.6, vib: 0.55, vibHz: 140, gain: 2.95
    },
    {
      // Wie der Turbo-Vierzylinder, aber mit Sportauspuff: offener, bellender, höher drehend
      id: 'turbo4s', name: 'Turbo Vier Sport', desc: 'Offener, bellender Sportauspuff', kind: 'combustion',
      layout: I4, displacement: 2.0, idleRpm: 900, maxRpm: 6500, blowdown: 62, flowExp: 0.6,
      headerM: 0.7, headerRatio: 1.05, headerSpread: 0.07,
      pipeM: 3.0, pipeLp: 2600, chamberM: 0.36, mufflerHz: 1500, mufflerQ: 0.8,
      unev: 0.24, variance: 0.9,
      boomHz: 95, drive: 1.55, rasp: 0.015, pipeFb: 0.25, chamberFb: 0.2, cabinHz: 1900, boomDb: 5, midDb: -2, exhaust: 0.8, bark: 0.65, vib: 0.5, vibHz: 150, gain: 2.7
    },
    {
      // Reihensechser mit Turbo im Stil des Supra: glatt und rauchig, dreht frei hoch
      id: 'supra', name: 'Supra Turbo', desc: 'Seidig, rauchig, dreht frei hoch', kind: 'combustion',
      layout: I6, displacement: 3.0, idleRpm: 800, maxRpm: 6500, blowdown: 64, flowExp: 0.6,
      headerM: 0.68, headerRatio: 1.04, headerSpread: 0.05,
      pipeM: 2.9, pipeLp: 2500, chamberM: 0.33, mufflerHz: 1600, mufflerQ: 0.85,
      unev: 0.16, variance: 0.7,
      boomHz: 85, drive: 1.6, rasp: 0.013, pipeFb: 0.25, chamberFb: 0.18, cabinHz: 1950, boomDb: 4.5, midDb: -2, exhaust: 0.85, bark: 0.75, vib: 0.5, vibHz: 140, gain: 5.0
    },
    {
      // Turbo-Fünfzylinder: die ungerade Zündfolge (144°) gibt das typische Trällern, rau und kehlig
      id: 'turbo5', name: 'Turbo Fünfzylinder', desc: 'Trällernd, rau und kehlig', kind: 'combustion',
      layout: I5, displacement: 2.5, idleRpm: 800, maxRpm: 6500, blowdown: 64, flowExp: 0.6,
      headerM: 0.66, headerRatio: 1.12, headerSpread: 0.14,
      pipeM: 2.8, pipeLp: 2400, chamberM: 0.34, mufflerHz: 1400, mufflerQ: 0.85,
      unev: 0.32, variance: 0.9,
      boomHz: 85, drive: 1.65, rasp: 0.015, pipeFb: 0.26, chamberFb: 0.18, cabinHz: 1850, boomDb: 5, midDb: -2, exhaust: 0.85, bark: 0.75, vib: 0.55, vibHz: 135, gain: 3.2
    },
    {
      // Turbo-Boxer: ungleich lange Krümmer je Zylinderbank = das bekannte Grummeln
      id: 'boxer', name: 'Turbo Boxer', desc: 'Grummelnd, ungleiche Krümmer', kind: 'combustion',
      layout: B4, displacement: 2.2, idleRpm: 800, maxRpm: 6200, blowdown: 62, flowExp: 0.55,
      headerM: 0.7, headerRatio: 1.35, headerSpread: 0.15,
      pipeM: 3.0, pipeLp: 2200, chamberM: 0.36, mufflerHz: 1150, mufflerQ: 0.8,
      unev: 0.36, variance: 0.9,
      boomHz: 75, drive: 1.5, rasp: 0.015, pipeFb: 0.24, chamberFb: 0.24, cabinHz: 1600, boomDb: 5.5, midDb: -2.5, exhaust: 0.75, bark: 0.5, vib: 0.6, vibHz: 120, gain: 3.0
    },
    {
      // Cross-Plane-V8: ungleichmäßige Impulsfolge je Bank = das typische Blubbern
      id: 'v8', name: 'V8 Bariton', desc: 'Tiefes Blubbern, Bariton', kind: 'combustion',
      layout: V8X, displacement: 4.4, idleRpm: 650, maxRpm: 5800, blowdown: 62, flowExp: 0.5,
      headerM: 0.8, headerRatio: 1.08, headerSpread: 0.12,
      pipeM: 2.8, pipeLp: 1800, chamberM: 0.42, mufflerHz: 1100, mufflerQ: 0.8,
      unev: 0.3, variance: 1.0,
      boomHz: 70, drive: 1.6, rasp: 0.015, pipeFb: 0.25, chamberFb: 0.24, cabinHz: 1500, boomDb: 6, midDb: -3, exhaust: 0.8, bark: 0.6, vib: 0.7, vibHz: 110, gain: 5.2
    },
    {
      // V10 mit Bank-Unterschieden: Halbordnungen machen ihn voll statt schrill; begrenztes Drehzahlband
      id: 'v10', name: 'Racing V10', desc: 'Voll und dicht, Rennsound', kind: 'combustion',
      layout: V10, displacement: 5.0, idleRpm: 900, maxRpm: 6800, blowdown: 64, flowExp: 0.5,
      headerM: 0.65, headerRatio: 1.1, headerSpread: 0.1,
      pipeM: 2.6, pipeLp: 2600, chamberM: 0.34, mufflerHz: 1800, mufflerQ: 0.8,
      unev: 0.35, variance: 0.8,
      boomHz: 90, drive: 1.5, rasp: 0.012, pipeFb: 0.26, chamberFb: 0.16, cabinHz: 1900, boomDb: 4, midDb: -3, exhaust: 0.8, bark: 0.7, vib: 0.55, vibHz: 150, gain: 9.5
    }
  ];

  var BY_ID = {};
  LIST.forEach(function (p, i) { p.index = i; BY_ID[p.id] = p; });

  return {
    DEFAULT: 'turbo4',
    list: LIST,
    ids: LIST.map(function (p) { return p.id; }),
    get: function (id) { return BY_ID[id] || BY_ID.turbo4; },
    next: function (id, step) {
      var i = (BY_ID[id] ? BY_ID[id].index : 0) + (step || 1);
      i = ((i % LIST.length) + LIST.length) % LIST.length;
      return LIST[i].id;
    }
  };
});
