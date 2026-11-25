"""
Test für tools/iconix-audiod/alsa_play.py ohne Head Unit: eine simulierte Soundkarte (libasound-Ersatz) und ein
simuliertes select(). Prüft die Wiedergabe-Schleife "play":
  - alle Daten von stdin landen vollständig und in der richtigen Reihenfolge im Gerät
  - zu Beginn 20 ms Stille, Rückmeldungen "P <Frames>" auf stdout, steigend
  - stockt der Dienst, legt der Player Stille nach (statt leerzulaufen) und meldet "underrun"
Aufruf:  python kit/tools/test_alsa_play.py
"""
import array
import importlib.util
import io
import math
import os
import sys
import tempfile
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
spec = importlib.util.spec_from_file_location('alsa_play', os.path.join(ROOT, 'tools', 'iconix-audiod', 'alsa_play.py'))
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

RATE = 24000
BUF = 960  # 40 ms


class FakePcm:
    """Gerät mit 40-ms-Puffer, das in simulierter Zeit abspielt (Zeit läuft in select() und beim blockierenden Schreiben)."""

    def __init__(self):
        self.t = 0.0          # simulierte Sekunden
        self.fill = 0         # Frames im Puffer
        self.running = False
        self.out = bytearray()
        self.played_at = 0.0

    def advance(self, dt):
        self.t += dt
        if self.running:
            self.fill = max(0, self.fill - int(round(dt * RATE)))


def make_lib(pcm):
    lib = types.SimpleNamespace()
    lib.snd_pcm_open = lambda *a: 0
    lib.snd_pcm_set_params = lambda *a: 0
    lib.snd_pcm_close = lambda h: 0
    lib.snd_strerror = lambda c: b'err'

    def get_params(h, b, p):
        b._obj.value = BUF
        p._obj.value = BUF // 4
        return 0
    lib.snd_pcm_get_params = get_params

    def writei(h, data, n):
        n = int(n)
        room = BUF - pcm.fill
        if room <= 0:
            # blockiert, bis Platz ist: Zeit läuft weiter
            if not pcm.running:
                pcm.running = True
            pcm.advance(0.005)
            room = BUF - pcm.fill
        w = min(n, room)
        pcm.out += bytes(data[:w * 2])
        pcm.fill += w
        if pcm.fill >= BUF:
            pcm.running = True
        return w
    lib.snd_pcm_writei = writei

    def delay(h, d):
        d._obj.value = pcm.fill
        return 0
    lib.snd_pcm_delay = delay
    lib.snd_pcm_state = lambda h: 3 if pcm.running else ap.SND_PCM_STATE_PREPARED

    def start(h):
        pcm.running = True
        return 0
    lib.snd_pcm_start = start
    lib.snd_pcm_recover = lambda h, e, s: 0
    return lib


def run(payload, stall_reads):
    """payload: Bytes auf stdin; stall_reads: Menge von select()-Aufrufnummern, bei denen 'nichts da' simuliert wird."""
    pcm = FakePcm()
    lib = make_lib(pcm)
    ap.load_alsa = lambda: lib
    ap.open_pcm = lambda l, dev, rate, lat, nonblock=False, channels=2: (1, None)

    calls = {'n': 0}

    def fake_select(r, w, x, timeout):
        calls['n'] += 1
        if calls['n'] in stall_reads:
            pcm.advance(timeout)
            return [], [], []
        return r, [], []
    ap.select = types.SimpleNamespace(select=fake_select)

    with tempfile.TemporaryFile() as f:
        f.write(payload)
        f.seek(0)
        rfd, wfd = os.pipe()
        old_in, old_out_fd = sys.stdin, os.dup(1)
        sys.stdin = io.TextIOWrapper(io.BufferedReader(io.FileIO(f.fileno(), closefd=False)))
        os.dup2(wfd, 1)
        err = io.StringIO()
        old_err = sys.stderr
        sys.stderr = err
        try:
            rc = ap.cmd_play('test', RATE, 40000, 1)
        finally:
            os.dup2(old_out_fd, 1)
            os.close(old_out_fd)
            os.close(wfd)
            sys.stdin = old_in
            sys.stderr = old_err
        reports = b''
        while True:
            chunk = os.read(rfd, 65536)
            if not chunk:
                break
            reports += chunk
        os.close(rfd)
    return rc, pcm, reports.decode(), err.getvalue()


def ring_bytes(per=256, num=4, ch=2, fmt=2, off=840, base=1024, name=b'x_ringBufferReal'):
    """Ringpuffer-Datei wie von SmartX (Intel IasAudioRingBufferReal)."""
    ss = 2 if fmt == 2 else 4
    b = bytearray(base + per * num * ch * ss + 256)
    b[100:100 + len(name)] = name
    ap.Ring.HEAD.pack_into(b, off, per, num, ch, 0, 0, 0, fmt, ss, 0, 1, 1, 0, 0, base - off - 40)
    return b


def test_mix():
    """Mischen in den Musikstrom: Aufbau prüfen, addieren, begrenzen; unter Linux auch die ganze Schleife."""
    fails = 0
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, 'smartx_T_p_ringbuffer')

    def check(ok, what):
        nonlocal fails
        print(('ok  ' if ok else 'FAIL') + ' Mix: ' + what)
        fails += not ok

    def ring(**k):
        with open(path, 'wb') as f:
            f.write(ring_bytes(**k))
        return ap.Ring(path, write=True)

    def refused(**k):
        try:
            ring(**k).close()
            return False
        except ap.RingError:
            return True
    check(refused(name=b'nichts') and refused(ch=0) and refused(base=1026), 'unbekannter Aufbau wird abgelehnt')
    slow = ap.audioop is None
    for mode in ([True] if slow else [False, True]):
        for fmt in (2, 3, 1):
            r = ring(fmt=fmt)
            m = ap.Mixer(r)
            if mode:
                m.fast = False
            unit = {2: 1.0, 3: 65536.0, 1: 1 / 32768.0}[fmt]
            for c in (0, 1):
                for i in range(1024):
                    v = (1000 if c == 0 else -2000) * unit
                    r.planes[c][i] = v if fmt == 1 else int(v)
            # über das Ende des Ringpuffers hinweg
            m.add(900, array.array('h', [300, 70] * 256).tobytes())
            L, R = [v / unit for v in r.planes[0]], [v / unit for v in r.planes[1]]
            hit = set(range(900, 1024)) | set(range(0, 132))
            ok = all(abs(L[i] - (1300 if i in hit else 1000)) < 0.6 and abs(R[i] - (-1930 if i in hit else -2000)) < 0.6 for i in range(1024))
            check(ok, 'addiert genau (Format %d%s), auch über das Ende, sonst unberührt' % (fmt, ', ohne audioop' if mode else ''))
            # laut + laut: nichts läuft über, kein Vorzeichenwechsel, danach wieder volle Musik
            big = {2: 31000, 3: 31000 * 65536, 1: 31000 / 32768.0}[fmt]
            worst = 0
            for k in range(12):
                for c in (0, 1):
                    for i in range(256):
                        r.planes[c][(k * 256 + i) % 1024] = big
                m.add((k * 256) % 1024, array.array('h', [20000, 20000] * 256).tobytes())
                worst = max(worst, max(abs(v / unit) for v in r.planes[0][(k * 256) % 1024:(k * 256) % 1024 + 256]))
            lo = min(v / unit for v in r.planes[0])
            duck = m.duck
            for k in range(400):
                for c in (0, 1):
                    for i in range(0, 256):
                        r.planes[c][(k * 256 + i) % 1024] = big if fmt == 1 else int(big)
                m.add((k * 256) % 1024, bytes(1024))
            ok = worst <= 32768 and lo > 20000 and duck == m.DUCK_MIN and m.duck > 0.97 and m.lim == 1.0
            check(ok, 'laut + laut begrenzt (Spitze %d, Musik bis %.2f), danach %.2f' % (worst, duck, m.duck))
            r.close()
    for fast in ([False] if slow else [True, False]):
        keep = ap.audioop
        ap.audioop = keep if fast else None
        g = ap.Gain(24000, 2)
        src = array.array('h', [12000, -6000] * 2400).tobytes()
        same = g.run(src) == src
        g.want = 0.5
        a = array.array('h', g.run(src))
        steps = max(abs(a[i] - a[i - 2]) for i in range(2, len(a)))
        g.want = 4.0
        b = array.array('h', g.run(src))
        ap.audioop = keep
        ok = same and abs(a[-2] - 6000) <= 8 and abs(a[600] - 6000) < 500 and steps < 2500 and max(map(abs, b)) <= 32767 and abs(b[-2] - 31000) < 300
        check(ok, 'Pegel weich und schnell, begrenzt%s (%d, größter Schritt %d, Spitze %d)' % ('' if fast else ', ohne audioop', a[-2], steps, max(map(abs, b))))
    if not hasattr(os, 'set_blocking') or sys.platform == 'win32':
        print('     (Schleife: nur unter Linux)')
        return fails
    # ganze Schleife: "CarPlay" schreibt, "SmartX" liest, der Dienst schickt einen Ton
    import mmap
    import subprocess
    import threading
    import time
    with open(path, 'wb') as f:
        f.write(ring_bytes())
    f = open(path, 'r+b')
    mm = mmap.mmap(f.fileno(), 0)
    mv = memoryview(mm)[1024:1024 + 8192].cast('h')
    ctl_r, ctl_w = os.pipe()
    while ctl_w <= 3 or ctl_r <= 3:        # 3 wird im Kind ersetzt
        ctl_r, ctl_w = os.dup(ctl_r), os.dup(ctl_w)
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'tools', 'iconix-audiod', 'alsa_play.py'), 'mix', 'T', '24000'],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, ICONIX_SHM_DIR=tmp, ICONIX_CTL='1'),
                         close_fds=False, preexec_fn=lambda: os.dup2(ctl_r, 3))
    played, heard, stop = [0], [], [False]
    threading.Thread(target=lambda: [played.__setitem__(0, int(x.split()[1])) for x in p.stdout], daemon=True).start()

    def put(off, v):
        mm[840 + off:844 + off] = int(v).to_bytes(4, 'little')

    def car():
        r = w = lvl = 0
        t = time.monotonic()
        while not stop[0]:
            while lvl <= 768:
                for c in (0, 1):
                    mv[c * 1024 + w:c * 1024 + w + 256] = memoryview(array.array('h', [4000] * 256))
                w = (w + 256) % 1024
                lvl += 256
                put(20, w)
                put(32, lvl)
            t += 256 / 48000.0 * 4        # viermal langsamer als echt: auch auf einem lahmen Prüfrechner sicher
            time.sleep(max(0, t - time.monotonic()))
            heard.extend(mv[r:r + 256].tolist())
            r = (r + 256) % 1024
            lvl -= 256
            put(16, r)
            put(32, lvl)
    th = threading.Thread(target=car)
    th.start()
    sent, t0 = 0, time.monotonic()
    while time.monotonic() - t0 < 3.0 and p.poll() is None:
        due = 1920 * 2 - (sent - played[0])
        if due > 0:
            p.stdin.write(array.array('h', [2000, 2000] * due).tobytes())
            p.stdin.flush()
            sent += due
        time.sleep(0.01)
    n = len(heard)
    n0 = len(heard)
    # leiser stellen, während der Ton schon im Vorlauf wartet: wirkt sofort
    os.write(ctl_w, b'G 0.5\n')
    time.sleep(0.45)
    check(abs(heard[-1] - 5000) <= 12 or abs(heard[-1] - 4000) <= 2, 'Pegel vom Dienst wirkt (%d)' % heard[-1])
    n = len(heard)
    p.stdin.close()
    time.sleep(1.3)
    stop[0] = True
    th.join()
    rc = p.wait(3)
    err = p.stderr.read().decode()
    mid = heard[n0 // 3:n0 - 200]
    check(rc == 0 and 'mischt in T' in err and n > 8000, 'Schleife läuft und endet sauber (Code %s)' % rc)
    good = sum(1 for v in mid if abs(v - 6000) <= 3)
    check(good >= len(mid) * 0.98, 'Musik + Motor durchgehend (%d von %d)' % (good, len(mid)))
    check(max(abs(b - a) for a, b in zip(heard[n - 1200:], heard[n - 1199:])) < 600 and abs(heard[-1] - 4000) <= 2, 'am Ende weich ausgeblendet, Musik danach unverändert')
    out = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'iconix-audiod', 'alsa_play.py'), 'rings'], stdout=subprocess.PIPE,
                         env=dict(os.environ, ICONIX_SHM_DIR=tmp)).stdout.decode()
    check('"name": "T"' in out and '"alive": false' in out, 'rings listet den Kanal')
    return fails


def main():
    fails = 0
    # 0,5 s Rampe als Mono-S16LE
    frames = RATE // 2
    payload = b''.join(int((i % 3000) - 1500).to_bytes(2, 'little', signed=True) for i in range(frames))
    pre = 2 * (RATE * 10 // 1000)  # 20 ms Stille zu Beginn

    rc, pcm, rep, err = run(payload, stall_reads=set())
    ok = rc == 0 and bytes(pcm.out[pre * 2:]) == payload and bytes(pcm.out[:pre * 2]) == bytes(pre * 2)
    print(('ok  ' if ok else 'FAIL') + ' Daten vollständig, in Reihenfolge, 20 ms Stille davor')
    fails += not ok
    vals = [int(l[2:]) for l in rep.split('\n') if l.startswith('P ')]
    ok = len(vals) > 3 and all(b >= a for a, b in zip(vals, vals[1:]))
    print(('ok  ' if ok else 'FAIL') + ' Rückmeldungen "P <Frames>" steigend (%d)' % len(vals))
    fails += not ok

    rc, pcm, rep, err = run(payload, stall_reads=set(range(5, 40)))
    zeros_inside = len(pcm.out) - len(payload) - pre * 2
    # Daten müssen vollständig enthalten sein, Stille nur dazwischen
    data = bytes(pcm.out)
    ok = rc == 0 and zeros_inside > 0 and 'underrun' in err and len(data) == len(payload) + pre * 2 + zeros_inside
    print(('ok  ' if ok else 'FAIL') + ' stockender Dienst: Stille nachgelegt (%d ms), als underrun gemeldet' % (zeros_inside // 2 * 1000 // RATE))
    fails += not ok
    # Rückmeldung zählt nur Frames des Dienstes: nachgelegte Stille darf nicht als gespielt gelten (sonst schreibt der
    # Dienst danach zu viel vor und die Verzögerung wächst mit jedem Stocken)
    vals = [int(l[2:]) for l in rep.split('\n') if l.startswith('P ')]
    ok = bool(vals) and max(vals) <= frames
    print(('ok  ' if ok else 'FAIL') + ' Rückmeldung ohne nachgelegte Stille (höchstens %d, gemeldet %d)' % (frames, max(vals or [0])))
    fails += not ok
    # kein Knacken: an den Rändern des Stockens keine Sprünge (leiser Sinus, größter Schritt zwischen zwei Samples)
    sine = b''.join(int(9000 * math.sin(2 * math.pi * 90 * i / RATE)).to_bytes(2, 'little', signed=True) for i in range(frames))
    rc, pcm, rep, err = run(sine, stall_reads=set(range(5, 40)))
    x = array.array('h', bytes(pcm.out))
    step = max(abs(x[i] - x[i - 1]) for i in range(pre + 50, len(x)))
    ok = rc == 0 and 'underrun' in err and step < 700   # 90 Hz: normal 212 je Sample; harte Stille spränge um bis zu 9000
    print(('ok  ' if ok else 'FAIL') + ' Stocken ohne Knacken (größter Sprung %d)' % step)
    fails += not ok
    # Stocken in der Stille hört man nicht: nicht als Aussetzer zählen
    rc, pcm, rep, err = run(bytes(frames * 2), stall_reads=set(range(5, 40)))
    ok = rc == 0 and 'underrun' not in err
    print(('ok  ' if ok else 'FAIL') + ' Stocken in der Stille zählt nicht')
    fails += not ok
    # zwei getrennte Hänger -> genau zwei Meldungen (je Stocken eine), Daten trotzdem vollständig
    rc, pcm, rep, err = run(payload, stall_reads=set(range(4, 9)) | set(range(14, 19)))
    n = err.count('underrun')
    data = bytes(pcm.out)
    ok = rc == 0 and n == 2 and len(data) > len(payload) + pre * 2
    print(('ok  ' if ok else 'FAIL') + ' zwei Hänger -> zwei Meldungen (%d)' % n)
    fails += not ok
    fails += test_mix()
    print('Alle alsa_play-Tests bestanden' if not fails else '%d Test(s) fehlgeschlagen' % fails)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
