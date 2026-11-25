'use strict';
/**
 * Sound Drive – Prüfung auf einen Blick.
 *
 *   node kit/tools/test_quick.js          kurz (unter 15 s): Tonweg, Klang, Autostart, Player, gleiche Dateien
 *   node kit/tools/test_quick.js --full   alles, auch Dauer- und Belastungstests (einige Minuten; wie auf GitHub)
 *
 * Die Tests laufen gleichzeitig. Ausgegeben wird je Test eine Zeile, bei einem Fehler das Ende seiner Ausgabe.
 * Exit-Code 1 bei einem Fehler.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const full = process.argv.indexOf('--full') >= 0;
const JOBS = ['test_iconix_route.js', 'test_autostart.js', 'test_alsa_play.py']
  .concat(full ? ['test_iconix_chaos.js', 'test_engine_e2e.js', 'test_daemon.js', 'iconix_popscan.js', 'iconix_soak.js'] : []);

let bad = 0;
if (!fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/profiles.js')).equals(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/profiles.js')))) { bad++; console.log('FAIL profiles.js: Dienst und App verschieden'); }

function run(job, py) {
  return new Promise((done) => {
    const t = Date.now(), isPy = /\.py$/.test(job);
    const p = cp.spawn(isPy ? py : process.execPath, [path.join(ROOT, 'kit/tools', job)], { cwd: ROOT, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    // kein Python da: überspringen statt scheitern
    p.on('error', () => { console.log('--   ' + job + ' (kein Python gefunden)'); done(); });
    p.on('close', (code) => {
      if (code < 0) return;
      console.log((code ? 'FAIL ' : 'ok   ') + job + ' (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
      if (code) { bad++; console.log(out.trim().split('\n').slice(-25).join('\n')); }
      done();
    });
  });
}

Promise.all(JOBS.map((j) => run(j, process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')))).then(() => {
  console.log(bad ? bad + ' Fehler' : full ? 'Alles in Ordnung (voller Test)' : 'Alles in Ordnung (kurzer Test; alles prüfen: --full)');
  process.exit(bad ? 1 : 0);
});
