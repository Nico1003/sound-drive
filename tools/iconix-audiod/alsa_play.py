#!/usr/bin/env python3
"""
Sound Drive – ALSA-Wiedergabe ohne aplay: Python + ctypes direkt gegen libasound.so.2.

Das Head Unit hat libasound und Python 3.12 (mgu-python), aber kein aplay. Dieses Skript ersetzt aplay:

  alsa_play.py play <gerät> <rate> [puffer_us] [kanäle]
                                     liest S16LE (Stereo oder Mono) von stdin und spielt es auf <gerät> ab
  alsa_play.py mix <Kanal> [rate]    mischt S16LE Stereo von stdin in den Musikstrom eines SmartX-Kanals (z. B. CarPlay)
  alsa_play.py probe <smartx|avb> <Kanal>   Radio-Test: drei leise Töne in einen laufenden Kanal mischen
  alsa_play.py rings                 gibt JSON aus: die Ringpuffer der SmartX-/AVB-Kanäle

Ausgaben auf stderr in Zeilen wie aplay (z. B. "underrun!!!"), damit engine.js sie zählt.
"""
import array
import ctypes
import ctypes.util
import json
import math
import mmap
import operator
import os
import re
import select
import signal
import struct
import sys
import time
import warnings

try:
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        import audioop          # bis Python 3.12 dabei: rechnet Blöcke in C (spart etwa 4/5 der Rechenzeit beim Mischen)
except ImportError:
    audioop = None

SND_PCM_STREAM_PLAYBACK = 0
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EPIPE = 32
ESTRPIPE = 86
SND_PCM_STATE_PREPARED = 2


def load_alsa():
    lib, last = None, None
    for n in ['libasound.so.2', 'libasound.so', '/usr/lib/libasound.so.2', '/lib/libasound.so.2']:
        try:
            lib = ctypes.CDLL(n)
            break
        except OSError as e:
            last = e
    if lib is None:
        # find_library ruft ldconfig/gcc auf – auf dem Head Unit (BusyBox) langsam oder nicht vorhanden, daher zuletzt
        try:
            n = ctypes.util.find_library('asound')
            lib = ctypes.CDLL(n) if n else None
        except Exception as e:
            last = e
    if lib is None:
        raise OSError('libasound nicht ladbar: %s' % last)
    lib.snd_strerror.restype = ctypes.c_char_p
    lib.snd_strerror.argtypes = [ctypes.c_int]
    lib.snd_pcm_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    lib.snd_pcm_set_params.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                       ctypes.c_int, ctypes.c_uint]
    lib.snd_pcm_writei.restype = ctypes.c_long
    lib.snd_pcm_writei.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    lib.snd_pcm_recover.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    lib.snd_pcm_close.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_delay.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_long)]
    lib.snd_pcm_state.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_start.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_get_params.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong)]
    return lib


def err(lib, code):
    try:
        return '%d %s' % (code, lib.snd_strerror(code).decode('utf-8', 'replace'))
    except Exception:
        return str(code)


def smartx_lock(dev):
    """SmartX legt beim Öffnen /run/smartx/smartx_<Kanal>_p.lock an. Gehört sie root (dieser Dienst), kommen
    BMWs eigene Prozesse (ent_alsa, Gruppe mgu_alsa) nicht mehr an den Kanal und z. B. CarPlay bleibt bis zum
    Neustart stumm. Daher vorher selbst anlegen: Besitzer und Gruppe wie der Ordner /run/smartx selbst (das Konto heißt
    ent_alsaroutingadapters; "ent_alsa" ist nur die von ls gekürzte Anzeige), 0660."""
    i = dev.find('smartx:')
    if i < 0 or not os.path.isdir('/run/smartx'):
        return
    lock = '/run/smartx/smartx_%s_p.lock' % dev[i + 7:]
    try:
        if not os.path.exists(lock):
            os.close(os.open(lock, os.O_CREAT | os.O_WRONLY, 0o660))
        own = os.stat('/run/smartx')
        st = os.stat(lock)
        if st.st_uid != own.st_uid or st.st_gid != own.st_gid:
            os.chown(lock, own.st_uid, own.st_gid)
        os.chmod(lock, 0o660)
    except Exception as e:
        sys.stderr.write('alsa_play: lock %s: %s\n' % (lock, e))
        sys.stderr.flush()


def open_pcm(lib, dev, rate, latency_us, channels=2):
    h = ctypes.c_void_p()
    r = lib.snd_pcm_open(ctypes.byref(h), dev.encode(), SND_PCM_STREAM_PLAYBACK, 0)
    if r < 0:
        return None, 'open: ' + err(lib, r)
    r = lib.snd_pcm_set_params(h, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, int(channels), int(rate), 1, int(latency_us))
    if r < 0:
        lib.snd_pcm_close(h)
        return None, 'set_params: ' + err(lib, r)
    return h, None


def realtime():
    """Echtzeit-Priorität (SCHED_RR) für den Player: Auf einem ausgelasteten Head Unit (Kamera beim Parken, viele
    Apps) kam er sonst zu spät an die Reihe -> Aussetzer, die als Knistern/Fehlgeräusch zu hören sind. Der Dienst
    läuft als root und darf das. Gibt 'ja' oder den Grund zurück."""
    try:
        os.sched_setscheduler(0, os.SCHED_RR, os.sched_param(5))
        return 'ja'
    except Exception as e:
        return 'nein (%s)' % (getattr(e, 'strerror', None) or e.__class__.__name__)


def realtime_parent():
    """Auch der Dienst (Node, erzeugt den Ton) bekommt Echtzeit-Priorität, unter der des Players: Kommt er auf einem
    ausgelasteten Head Unit zu spät dran, läuft der Puffer leer (Aussetzer). Nur der Hauptthread, und Kindprozesse
    erben sie nicht (RESET_ON_FORK). Nur wenn der Dienst es verlangt (ICONIX_RT_PARENT); scheitert es, bleibt alles
    wie es ist."""
    if os.environ.get('ICONIX_RT_PARENT') != '1':
        return None
    try:
        pid = os.getppid()
        if pid <= 1:
            return None
        os.sched_setscheduler(pid, os.SCHED_RR | os.SCHED_RESET_ON_FORK, os.sched_param(2))
        return 'ja'
    except Exception as e:
        # ohne Echtzeit wenigstens vor den anderen normalen Prozessen (Player und Dienst)
        for p in (0, pid):
            try:
                os.setpriority(os.PRIO_PROCESS, p, -10)
            except Exception:
                pass
        return 'nein (%s)' % (getattr(e, 'strerror', None) or e.__class__.__name__)


def release_parent(rp, gain):
    """Kein Ton mehr: Der Dienst läuft wieder wie jeder andere – außer ein anderer Player übernimmt gerade."""
    gain.poll()
    if rp == 'ja' and not gain.keep_rt:
        try:
            os.sched_setscheduler(os.getppid(), os.SCHED_OTHER, os.sched_param(0))
        except Exception:
            pass


def on_sigterm(_sig, _frame):
    raise KeyboardInterrupt()       # wie ein normales Ende: aufräumen statt sofort weg


class Conceal:
    """Überbrückt ein Stocken des Dienstes ohne Knacken: Harte Stille mitten im Ton hört man als Kratzen. Stattdessen
    wird der zuletzt gespielte Ton rückwärts (nahtlos am letzten Wert) fortgesetzt und über FADE_MS ausgeblendet; geht
    es weiter, blenden die neuen Daten über RESUME_MS ein."""
    FADE_MS, RESUME_MS = 30, 6

    def __init__(self, rate, channels):
        self.ch = channels
        self.keep = max(1, rate * 20 // 1000)
        self.fade = max(1, rate * self.FADE_MS // 1000)
        self.resume = max(1, rate * self.RESUME_MS // 1000)
        self.tail = array.array('h')
        self.pos, self.active = 0, False

    def remember(self, data):
        n = self.keep * self.ch * 2
        if len(data) >= n:
            self.tail = array.array('h', data[-n:])
        elif data:
            self.tail = array.array('h', (self.tail.tobytes() + data)[-n:])

    def audible(self):
        return any(v > 60 or v < -60 for v in self.tail)

    def start(self):
        if not self.active:
            self.active, self.pos = True, 0

    def fill(self, n):
        """n Frames Fortsetzung (Hin- und Herlaufen im letzten Stück Ton, leiser werdend)."""
        ch, t = self.ch, self.tail
        m = len(t) // ch
        out = array.array('h', bytes(2 * n * ch))
        if m < 2:
            self.pos += n
            return out
        span = 2 * (m - 1)
        for i in range(n):
            p = self.pos + i
            g = 1.0 - float(p) / self.fade
            if g <= 0:
                break
            k = (p + 1) % span
            j = (m - 1 - k) if k < m else (k - (m - 1))
            for c in range(ch):
                out[i * ch + c] = int(t[j * ch + c] * g)
        self.pos += n
        return out

    def join(self, data):
        """Erste neue Daten nach dem Stocken einblenden (über die auslaufende Fortsetzung)."""
        if not self.active or not data:
            return data
        ch = self.ch
        a = array.array('h', data)
        n = min(self.resume, len(a) // ch)
        if n:
            f = self.fill(n)
            for i in range(n):
                r = (i + 1.0) / n
                for c in range(ch):
                    k = i * ch + c
                    a[k] = int(a[k] * r + f[k] * (1.0 - r))
        self.active = False
        return a.tobytes()


class Gain:
    """Ausgangspegel, vom Dienst über einen eigenen Kanal (fd 3, Zeilen "G <Faktor>") gestellt. Er wirkt erst hier, ganz am Ende:
    Ton, der schon im Vorlauf wartet, bekommt den neuen Pegel auch. So bleibt der Motorsound beim Drehen am
    Lautstärkeknopf gleich laut, statt dem Knopf um den Vorlauf hinterherzuhinken. Änderungen laufen über ~15 ms, und
    was über TOP ginge, wird leiser geregelt statt abgeschnitten."""
    TOP, PART = 31000.0, 64

    def __init__(self, rate, channels):
        self.ch = channels
        self.step = min(1.0, self.PART / (rate * 0.005))
        self.back = self.PART / (rate * 0.4)
        self.g, self.want, self.lim = 1.0, 1.0, 1.0
        self.buf = b''
        self.fresh = True       # noch nichts gespielt: den ersten Pegel ohne Übergang nehmen
        self.keep_rt = False    # gleich folgt ein anderer Player: dem Dienst die Echtzeit-Priorität lassen
        self.fds = []
        if os.environ.get('ICONIX_CTL') == '1':
            try:
                os.set_blocking(3, False)
                self.fds = [3]
            except Exception:
                self.fds = []

    def poll(self):
        while self.fds:
            try:
                d = os.read(3, 4096)
            except BlockingIOError:
                return
            except OSError:
                d = b''
            if not d:
                self.fds = []
                return
            lines = (self.buf + d).split(b'\n')
            self.buf = lines.pop()[-64:]
            for x in lines:
                if x == b'K':
                    self.keep_rt = True
                elif x[:2] == b'G ':
                    try:
                        v = float(x[2:])
                    except ValueError:
                        continue
                    if 0.0 <= v <= 16.0:
                        self.want = v

    def run(self, data):
        if self.fresh and data:
            self.fresh, self.g = False, self.want
        if not data or (self.g == 1.0 and self.want == 1.0 and self.lim == 1.0):
            return data
        n = self.PART * self.ch * 2
        out = []
        for i in range(0, len(data), n):
            p = data[i:i + n]
            peak = audioop.max(p, 2) if audioop is not None else max(map(abs, array.array('h', p)))
            self.g += (self.want - self.g) * self.step
            if abs(self.want - self.g) < 0.0005:
                self.g = self.want
            need = min(1.0, self.TOP / (peak * self.g)) if peak * self.g > self.TOP else 1.0
            self.lim = need if need < self.lim else min(need, self.lim + self.back)
            k = self.g * self.lim
            if audioop is not None:
                out.append(audioop.mul(p, 2, k))
            else:
                out.append(array.array('h', [int(v * k) for v in array.array('h', p)]).tobytes())
        return b''.join(out)


def cmd_play(dev, rate, latency_us=200000, channels=2):
    lib = load_alsa()
    smartx_lock(dev)
    h, e = open_pcm(lib, dev, rate, latency_us, channels=channels)
    if not h and latency_us > 30000:
        # Kanal nimmt den größeren Puffer nicht: mit dem kleinen
        h, e = open_pcm(lib, dev, rate, 30000, channels=channels)
    if not h:
        sys.stderr.write('alsa_play: %s (%s)\n' % (e, dev))
        sys.stderr.flush()
        return 2
    bsize, psize = ctypes.c_ulong(0), ctypes.c_ulong(0)
    lib.snd_pcm_get_params(h, ctypes.byref(bsize), ctypes.byref(psize))
    rt = realtime()
    rp = realtime_parent()
    if rp is not None:
        rt += ', Dienst ' + rp
    sys.stderr.write('alsa_play: spielt auf %s mit %d Hz, %d Kanal/Kanäle, Puffer %d ms, Periode %d ms, Echtzeit %s\n' % (
        dev, rate, channels, bsize.value * 1000 // max(1, rate), psize.value * 1000 // max(1, rate), rt))
    sys.stderr.flush()
    frame_bytes = 2 * channels
    chunk = 1024 * frame_bytes
    pending = b''
    # Rückmeldung an engine.js: "P <gespielte Frames>" auf stdout. Damit schreibt der Dienst nur so viel vor,
    # wie wirklich fehlt – ohne sie staute sich Ton in der Pipe (bis ~1 s Verzögerung).
    # Gemeldet werden nur Frames des Dienstes: Die Stille, die dieses Skript selbst nachlegt (Start, Stocken), zählt
    # nicht mit. Sonst hielte der Dienst jede nachgelegte Stille für gespielten eigenen Ton, schriebe entsprechend mehr
    # nach – und die Verzögerung wüchse mit jedem Stocken um mindestens 10 ms, bis der Player neu startet.
    total = 0
    own = 0      # selbst nachgelegte Stille (Frames)
    delay = ctypes.c_long(0)

    def report():
        # ALSA startet sonst erst bei vollem Puffer; ist der größer als der Vorlauf des Dienstes, bliebe es still
        if total > 0 and lib.snd_pcm_state(h) == SND_PCM_STATE_PREPARED:
            lib.snd_pcm_start(h)
        if lib.snd_pcm_delay(h, ctypes.byref(delay)) < 0:
            return
        try:
            os.write(1, ('P %d\n' % max(0, total - own - max(0, delay.value))).encode())
        except OSError:
            pass
    # Schutz gegen Leerlaufen: Stockt der Dienst (Head Unit beim Hochfahren ausgelastet), spielt SmartX sonst den
    # alten Inhalt seines Ringpuffers in Schleife ab - klingt wie ein Quietschen. Darum hier kurz vorher selbst
    # Stille nachlegen. Wird als "underrun" gemeldet, damit der Dienst seinen Vorlauf vergrößert.
    guard = max(1, rate * 12 // 1000)          # weniger als 12 ms im Puffer -> Stille nachlegen
    fill_n = max(1, rate * 10 // 1000)         # je 10 ms
    zeros = bytes(fill_n * frame_bytes)
    conceal = Conceal(rate, channels)
    gain = Gain(rate, channels)
    fd = sys.stdin.fileno()
    fills = 0
    stalled = False
    # mit 20 ms Stille beginnen: SmartX hat dann sofort frische Daten statt alter Reste im Ringpuffer
    for _ in range(2):
        w = lib.snd_pcm_writei(h, zeros, fill_n)
        if w > 0:
            total += w
            own += w
    try:
        while True:
            if total > 0:
                d = delay.value if lib.snd_pcm_delay(h, ctypes.byref(delay)) >= 0 else 0
                wait = max(0.002, (d - guard) / float(rate))
                ready = select.select([fd] + gain.fds, [], [], wait)[0]
                if gain.fds and gain.fds[0] in ready:
                    gain.poll()
                    if fd not in ready:
                        continue
                if not ready:
                    r = lib.snd_pcm_delay(h, ctypes.byref(delay))
                    if r < 0:
                        lib.snd_pcm_recover(h, int(r), 1)
                        delay.value = 0
                    if delay.value < guard:
                        conceal.start()
                        w = lib.snd_pcm_writei(h, gain.run(conceal.fill(fill_n).tobytes()), fill_n)
                        if w > 0:
                            total += w
                            own += w
                            # je Stocken EINE Meldung (beim ersten Nachlegen), damit der Dienst jedes Mal
                            # mitzählt und seinen Vorlauf vergrößert – auch nach vielen Aussetzern. War ohnehin
                            # Stille (Motor aus, stummgeschaltet), hört man nichts: keine Meldung.
                            if not stalled and conceal.audible():
                                fills += 1
                                sys.stderr.write('underrun!!! (Stille nachgelegt, #%d)\n' % fills)
                                sys.stderr.flush()
                            stalled = True
                            report()
                        elif w < 0:
                            lib.snd_pcm_recover(h, int(w), 1)
                    continue
            data = os.read(fd, chunk)
            if not data:
                break
            stalled = False
            data = pending + data
            n = len(data) // frame_bytes
            pending = data[n * frame_bytes:]
            raw = conceal.join(data[:n * frame_bytes])
            gain.poll()
            buf = gain.run(raw)
            off = 0
            while off < n:
                w = lib.snd_pcm_writei(h, buf[off * frame_bytes:], n - off)
                if w < 0:
                    if w in (-EPIPE, -ESTRPIPE) and conceal.audible():
                        sys.stderr.write('underrun!!!\n')
                        sys.stderr.flush()
                    r = lib.snd_pcm_recover(h, int(w), 1)
                    if r < 0:
                        sys.stderr.write('alsa_play: write: %s\n' % err(lib, r))
                        sys.stderr.flush()
                        return 3
                    # der Ton war weg: den Rest weich einblenden statt mit einem Sprung
                    conceal.start()
                    conceal.pos = conceal.fade
                    buf = buf[:off * frame_bytes] + conceal.join(buf[off * frame_bytes:])
                    continue
                off += w
                total += w
            conceal.remember(raw)
            report()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        release_parent(rp, gain)
        lib.snd_pcm_close(h)
    return 0


class RingError(Exception):
    pass


class Ring:
    """Ringpuffer eines SmartX-Kanals im gemeinsamen Speicher (/dev/shm/smartx_<Kanal>_p_ringbuffer).

    Aufbau laut Intels Quelltext (intel/AVB-AudioModules, IasAudioRingBufferReal.hpp): neun 32-Bit-Werte – Periode,
    Perioden, Kanäle, (0), Lese-, Schreibposition, Format, Bytes je Wert, Füllstand –, vier Schalter und ein Zeiger auf die
    Daten (relativ zu sich selbst). Die Kanäle liegen hintereinander (nicht verschachtelt).
    Wo der Kopf in der Datei liegt, steht nirgends fest; er wird gesucht und nur genommen, wenn ALLES zusammenpasst
    (und nur eine Stelle passt). Sonst fasst dieses Programm den Speicher nicht an."""
    HEAD = struct.Struct('<9I4Bq')
    FORMATS = {1: ('f', 4), 2: ('h', 2), 3: ('i', 4)}

    def __init__(self, path, write=False):
        self.path = path
        fd = os.open(path, os.O_RDWR if write else os.O_RDONLY)
        try:
            st = os.fstat(fd)
            self.ino, self.size = st.st_ino, st.st_size
            if self.size < 1024 or self.size > 1 << 24:
                raise RingError('Größe %d' % self.size)
            self.mm = mmap.mmap(fd, self.size, access=mmap.ACCESS_WRITE if write else mmap.ACCESS_READ)
        finally:
            os.close(fd)
        hits = self._locate()
        if len(hits) != 1:
            raise RingError('Aufbau unbekannt (%d Treffer)' % len(hits))
        self.off, h = hits[0]
        self.period, self.periods, self.channels = h[0], h[1], h[2]
        self.frames = self.period * self.periods
        self.code, self.width = self.FORMATS[h[6]]
        self.static = (h[0], h[1], h[2], h[6], h[7])
        base = self.off + 40 + h[13]
        self.planes = []
        if write:
            span = self.frames * self.width
            mv = memoryview(self.mm)
            self.planes = [mv[base + c * span:base + (c + 1) * span].cast(self.code) for c in range(min(2, self.channels))]

    @classmethod
    def check(cls, h, off, size):
        per, num, ch, _max, r, w, fmt, ss, lvl, shared, init, rp, wp, rel = h
        if not (16 <= per <= 16384 and 2 <= num <= 256 and 1 <= ch <= 32 and _max <= 64 and fmt in cls.FORMATS):
            return False
        if ss != cls.FORMATS[fmt][1] or shared != 1 or init != 1 or rp > 1 or wp > 1:
            return False
        n = per * num
        if r >= n or w >= n or lvl > n:
            return False
        base = off + 40 + rel
        return base > 0 and base % 4 == 0 and base + n * ch * ss <= size

    def _locate(self):
        data = self.mm[:]
        if b'_ringBufferReal' not in data:
            raise RingError('Name fehlt')
        out = []
        for off in range(0, self.size - self.HEAD.size, 8):
            # schnell vorsortieren: die beiden Schalter "gemeinsam" und "fertig" stehen auf 1
            if data[off + 36] != 1 or data[off + 37] != 1:
                continue
            h = self.HEAD.unpack_from(data, off)
            if self.check(h, off, self.size):
                out.append((off, h))
        return out

    def state(self):
        """(lesen, schreiben, Füllstand) – oder RingError, wenn der Kopf nicht mehr stimmt (Kanal neu angelegt)."""
        for _ in range(8):
            h = self.HEAD.unpack_from(self.mm, self.off)
            if (h[0], h[1], h[2], h[6], h[7]) != self.static or h[4] >= self.frames or h[5] >= self.frames or h[8] > self.frames:
                raise RingError('Kopf geändert')
            # mitten in einer Änderung gelesen (Position schon neu, Füllstand noch alt)? noch einmal
            if (h[5] - h[4] - h[8]) % self.frames == 0:
                break
        return h[4], h[5], h[8]

    def replaced(self):
        try:
            return os.stat(self.path).st_ino != self.ino
        except OSError:
            return True

    def close(self):
        for p in self.planes:
            p.release()
        self.planes = []
        try:
            self.mm.close()
        except BufferError:
            pass


class Mixer:
    """Addiert den Motorsound auf die Musik im Ringpuffer. Reicht der Platz nach oben nicht, gibt zuerst die Musik etwas
    nach (höchstens auf DUCK_MIN), dann wird die Summe leiser geregelt – nichts wird abgeschnitten (das klänge wie Kratzen).
    Alle Regler sind Verläufe über den Block und gelten für beide Seiten gleich."""
    GAIN, TOP, DUCK_MIN, PARTS = 1.0, 30500.0, 0.75, 8

    def __init__(self, ring):
        self.ring = ring
        self.duck, self.lim = 1.0, 1.0
        self.fast = audioop is not None and ring.code in 'hi'

    def _read(self, p, pos, n):
        a = min(n, self.ring.frames - pos)
        d = p[pos:pos + a].tobytes()
        return d + p[0:n - a].tobytes() if a < n else d

    def _write(self, p, pos, n, data):
        a = min(n, self.ring.frames - pos)
        src = memoryview(data).cast('B').cast(self.ring.code)
        p[pos:pos + a] = src[:a]
        if a < n:
            p[0:n - a] = src[a:]

    def _ramp(self, g0, g1):
        """Verläufe je Teilstück: nach unten in den ersten beiden, nach oben über den ganzen Block."""
        k = self.PARTS
        if g1 < g0:
            return [(g0 + g1) * 0.5] + [g1] * (k - 1)
        return [g0 + (g1 - g0) * (i + 1) / k for i in range(k)]

    def _next(self, old, want, n, low):
        # zurück in ~0,4 s
        return want if want < old else min(want, old + (1.0 - low) * n / 19200.0)

    def add(self, pos, stereo):
        """stereo: Motorsound ab Frame pos des Ringpuffers (S16LE Stereo, 48 kHz)."""
        n = len(stereo) // 4
        if not n:
            return
        (self._add_fast if self.fast else self._add_slow)(pos, n, stereo)

    def _add_fast(self, pos, n, stereo):
        planes, w = self.ring.planes, self.ring.width
        if len(planes) > 1:
            eng = [audioop.tomono(stereo, 2, 1, 0), audioop.tomono(stereo, 2, 0, 1)]
        else:
            eng = [audioop.tomono(stereo, 2, 0.5, 0.5)]
        pe = max(audioop.max(e, 2) for e in eng)
        calm = self.duck == 1.0 and self.lim == 1.0
        if pe == 0 and calm:
            return
        music = [self._read(p, pos, n) for p in planes]
        scale = 1.0 if w == 2 else 1.0 / 65536.0
        pm = max(audioop.max(m, w) for m in music) * scale
        if calm and pm + pe <= self.TOP:
            for p, m, e in zip(planes, music, eng):
                self._write(p, pos, n, audioop.add(m, e if w == 2 else audioop.lin2lin(e, 2, 4), w))
            return
        want = 1.0 if pm + pe <= self.TOP or pm <= 0 else max(self.DUCK_MIN, min(1.0, (self.TOP - pe) / pm))
        d0, d1 = self.duck, self._next(self.duck, want, n, self.DUCK_MIN)
        k = max(1, n // self.PARTS)
        cuts = [(i * k, n if i == self.PARTS - 1 else min(n, (i + 1) * k)) for i in range(self.PARTS)]
        dg = self._ramp(d0, d1)
        half = []
        for m, e in zip(music, eng):
            m4 = m if w == 4 else audioop.lin2lin(m, 2, 4)
            e4 = audioop.mul(audioop.lin2lin(e, 2, 4), 4, 0.5)
            m4 = b''.join(audioop.mul(m4[a * 4:b * 4], 4, 0.5 * g) for (a, b), g in zip(cuts, dg))
            half.append(audioop.add(m4, e4, 4))          # halbe Höhe: kann nicht überlaufen
        peak = max(audioop.max(x, 4) for x in half) / 32768.0
        l0, l1 = self.lim, self._next(self.lim, min(1.0, self.TOP / peak) if peak > 0 else 1.0, n, 0.5)
        lg = self._ramp(l0, l1)
        for p, x in zip(planes, half):
            out = b''.join(audioop.mul(x[a * 4:b * 4], 4, 2.0 * g) for (a, b), g in zip(cuts, lg))
            self._write(p, pos, n, out if w == 4 else audioop.lin2lin(out, 4, 2))
        self.duck, self.lim = d1, l1

    def _add_slow(self, pos, n, stereo):
        ring, code = self.ring, self.ring.code
        planes = ring.planes
        a = array.array('h', stereo)
        eng = [a[0::2], a[1::2]] if len(planes) > 1 else [[(x + y) * 0.5 for x, y in zip(a[0::2], a[1::2])]]
        pe = max(max(max(e), -min(e)) for e in eng)
        if pe <= 0 and self.duck == 1.0 and self.lim == 1.0:
            return
        unit = {'h': 1.0, 'i': 1.0 / 65536.0, 'f': 32768.0}[code]
        music = []
        for p in planes:
            m = array.array(code, self._read(p, pos, n))
            music.append(m if unit == 1.0 else [v * unit for v in m])
        pm = max(max(max(m), -min(m)) for m in music)
        want = 1.0 if pm + pe <= self.TOP or pm <= 0 else max(self.DUCK_MIN, min(1.0, (self.TOP - pe) / pm))
        d0, d1 = self.duck, self._next(self.duck, want, n, self.DUCK_MIN)
        st = (d1 - d0) / n
        sums = []
        for m, e in zip(music, eng):
            if d0 == 1.0 and d1 == 1.0:
                sums.append(list(map(operator.add, m, e)))
            else:
                sums.append([v * (d0 + st * i) + x for i, (v, x) in enumerate(zip(m, e), 1)])
        peak = max(max(max(x), -min(x)) for x in sums)
        l0, l1 = self.lim, self._next(self.lim, min(1.0, self.TOP / peak) if peak > 0 else 1.0, n, 0.5)
        if l0 != 1.0 or l1 != 1.0:
            q = min(n, 64) if l1 < l0 else n
            st = (l1 - l0) / q
            sums = [[v * (l0 + st * i if i < q else l1) for i, v in enumerate(x, 1)] for x in sums]
        for p, x in zip(planes, sums):
            x = [32767.0 if v > 32767.0 else (-32767.0 if v < -32767.0 else v) for v in x]
            if code == 'h':
                out = array.array('h', map(int, x))
            elif code == 'i':
                out = array.array('i', [int(v * 65536.0) for v in x])
            else:
                out = array.array('f', [v / 32768.0 for v in x])
            self._write(p, pos, n, out)
        self.duck, self.lim = d1, l1


class Upsample:
    """24 -> 48 kHz, S16LE Stereo: in C (audioop.ratecv), ohne audioop Zwischenwerte mit vier Punkten (-1, 9, 9, -1)/16."""

    def __init__(self, gain):
        self.gain, self.state, self.hist = gain, None, [[0.0] * 3, [0.0] * 3]

    def run(self, data):
        if audioop is not None:
            out, self.state = audioop.ratecv(data, 2, 2, 24000, 48000, self.state)
            return audioop.mul(out, 2, self.gain)
        a = array.array('h', data)
        out = array.array('h', bytes(len(a) * 4))
        for c in (0, 1):
            h = self.hist[c] + [v * self.gain for v in a[c::2]]
            self.hist[c] = h[-3:]
            out[c::4] = array.array('h', map(int, h[1:-2]))
            out[c + 2::4] = array.array('h', [int(max(-32767.0, min(32767.0, (9.0 * (p + q) - o - r) * 0.0625)))
                                              for o, p, q, r in zip(h, h[1:], h[2:], h[3:])])
        return out.tobytes()


def cmd_mix(channel, rate=24000):
    """Motorsound (S16LE Stereo, rate Hz, von stdin) in den Musikstrom eines SmartX-Kanals (48 kHz) mischen.

    Dieses Programm öffnet den Kanal nicht: Der Besitzer (CarPlay) schreibt weiter seine Musik. Jede Musik, die neu
    im Puffer steht, bekommt hier den Motorsound dazu, bevor SmartX sie liest (10 bis 20 ms später). Es braucht keine
    Verbindung im Audiomanager – der Knopf bleibt bei der Musik, nichts wird abgesenkt oder unterbrochen."""
    path = os.path.join(os.environ.get('ICONIX_SHM_DIR', '/dev/shm'), 'smartx_%s_p_ringbuffer' % channel)
    if rate != 24000:
        sys.stderr.write('alsa_play: mix: Rate %d\n' % rate)
        return 2
    try:
        ring = Ring(path, write=True)
    except (OSError, RingError, ValueError) as e:
        sys.stderr.write('alsa_play: Musikstrom %s: %s\n' % (channel, e))
        sys.stderr.flush()
        return 2
    rt = realtime()
    rp = realtime_parent()
    if rp is not None:
        rt += ', Dienst ' + rp
    sys.stderr.write('alsa_play: mischt in %s (%d x %d Frames, %d Kanäle, Format %s), Puffer %d ms, Periode %d ms, Echtzeit %s\n' % (
        channel, ring.periods, ring.period, ring.channels, ring.code, ring.frames // 48, ring.period // 48, rt))
    sys.stderr.flush()
    fd = sys.stdin.fileno()
    os.set_blocking(fd, False)
    # Datenstrom vom Dienst (24 kHz): queue ab qpos; done = davon verbrauchte Frames
    queue, qpos, done, eof = bytearray(), 0, 0, False
    mixer, conceal, gain = Mixer(ring), Conceal(rate, 2), Gain(rate, 2)
    up = Upsample(mixer.GAIN)
    ready = bytearray()             # schon mit 48 kHz, noch nicht gemischt (höchstens ein paar Frames)
    wlast, moved, live = None, 0.0, False
    idle_at, replaced_at, reported = time.monotonic(), 0.0, -1
    fills, stalled, lates, closing = 0, False, 0, 0.0

    def have():
        return (len(queue) - qpos) // 4

    def drop(n):
        nonlocal qpos, done
        qpos += n * 4
        done += n
        if qpos > 65536:
            del queue[:qpos]
            qpos = 0

    def take(k):
        """k Frames des Dienstes; fehlen welche, weich überbrücken (Conceal) statt Stille mitten im Ton."""
        nonlocal fills, stalled
        n = min(k, have())
        data = bytes(queue[qpos:qpos + n * 4])
        drop(n)
        if n:
            data = conceal.join(data)
            conceal.remember(data)
            stalled = False
        if n < k:
            conceal.start()
            data += conceal.fill(k - n).tobytes()
            if not stalled and not eof and conceal.audible():
                fills += 1
                sys.stderr.write('underrun!!! (Stille nachgelegt, #%d)\n' % fills)
                sys.stderr.flush()
            stalled = True
        return gain.run(data)

    def frames48(n):
        """n Frames mit 48 kHz (S16LE Stereo)."""
        while len(ready) < n * 4:
            ready.extend(up.run(take((n * 4 - len(ready) + 7) // 8)))
        out = bytes(ready[:n * 4])
        del ready[:n * 4]
        return out

    first = False
    # SmartX liest eine Periode (auch eine größere als die des Kanals) am Stück und rückt die Leseposition erst danach weiter
    guard = min(max(ring.period, 512), ring.frames // 2)
    poll = min(0.004, ring.period / 48000.0 / 2.0)
    try:
        while True:
            # 1) was der Dienst geschickt hat
            gain.poll()
            while not eof:
                try:
                    d = os.read(fd, 65536)
                except BlockingIOError:
                    break
                if not d:
                    eof = True
                    break
                queue += d
            now = time.monotonic()
            if eof:
                # zu Ende: den Rest noch spielen und weich ausblenden, dann aufhören
                if not closing:
                    closing = now + 1.0
                if not live or now > closing or (not have() and conceal.active and conceal.pos >= conceal.fade):
                    break
            # 2) neue Musik im Puffer?
            try:
                r, w, lvl = ring.state()
                if now - replaced_at > 0.5:
                    replaced_at = now
                    if ring.replaced():
                        raise RingError('Kanal neu angelegt')
            except RingError as e:
                sys.stderr.write('alsa_play: Musikstrom: %s\n' % e)
                sys.stderr.flush()
                return 3
            if wlast is None:
                wlast = w
            new = (w - wlast) % ring.frames
            if new:
                if not live:
                    live = True
                    # alter Ton von vor der Pause: verwerfen, mit dem neuesten weitermachen und einblenden
                    drop(max(0, have() - rate // 20 - ring.frames // 2))
                    del ready[:]
                    conceal.start()
                    conceal.pos = conceal.fade
                    stalled, first = True, True
                moved, start = now, wlast
                wlast = w
                valid = min(new, lvl)                    # nur was noch ungelesen ist (nach einem Zurücksetzen auch weniger)
                safe = max(0, lvl - guard)               # die vordersten Frames liest SmartX vielleicht gerade
                use = min(valid, safe)
                lost = new - use
                if lost:
                    # zu spät dran: dieser Teil der Musik ist schon durch; den Motorsound dafür überspringen
                    if not first and valid == new:
                        frames48(lost)
                        # danach weich einblenden
                        conceal.start()
                        conceal.pos = conceal.fade
                    if not first and conceal.audible():
                        lates += 1
                        if lates <= 5 or lates % 50 == 0:
                            sys.stderr.write('underrun!!! (Musik schon gelesen, #%d)\n' % lates)
                            sys.stderr.flush()
                    start = (w - use) % ring.frames
                if use:
                    mixer.add(start, frames48(use))
                    first = False
                idle_at = now
            elif live and now - moved > 0.3:
                live = False
                idle_at = now
            # 3) Musik steht: den Ton des Dienstes in Echtzeit verwerfen, damit er weiterläuft und beim nächsten Stück frisch ist
            if not live:
                n = min(have(), int((now - idle_at) * rate))
                if n > 0:
                    drop(n)
                    idle_at += n / float(rate)
                if now - idle_at > 0.5:
                    idle_at = now - 0.5
                conceal.tail = array.array('h')
            # 4) Rückmeldung: verbraucht, abzüglich was im Ringpuffer noch vor dem Lautsprecher steht (höchstens 20 ms: in
            #    einem großen Puffer bliebe dem Dienst sonst kein Vorlauf mehr)
            p = max(0, done - (min(lvl, 960) // 2 if live else 0))
            if p != reported:
                reported = p
                try:
                    os.write(1, ('P %d\n' % p).encode())
                except OSError:
                    break
            time.sleep(poll)
    except KeyboardInterrupt:
        pass
    finally:
        release_parent(rp, gain)
        ring.close()
    return 0


def cmd_probe(bar, name):
    """Radio-Test: drei leise Töne (je 0,35 s, -24 dBFS) zu dem mischen, was in diesem Kanal gerade läuft."""
    if bar not in ('smartx', 'avb') or not re.match(r'[A-Za-z0-9_]{1,100}$', name):
        return 2
    try:
        ring = Ring(os.path.join(os.environ.get('ICONIX_SHM_DIR', '/dev/shm'), '%s_%s_p_ringbuffer' % (bar, name)), write=True)
    except (OSError, RingError, ValueError) as e:
        sys.stderr.write('probe: %s\n' % e)
        return 2
    realtime()
    rate = 24000 if '_CF_24_' in name else 48000
    beep, tone = int(rate * 0.35), array.array('h')
    for _k in range(3):
        for i in range(2 * beep):
            env = max(0.0, min(1.0, i / (rate * 0.02), (beep - i) / (rate * 0.02)))
            v = int(2060 * env * math.sin(2 * math.pi * 620.0 * i / rate)) if env > 0 else 0
            tone.extend((v, v))
    data, pos, done, mixer, wlast = tone.tobytes(), 0, 0, Mixer(ring), None
    poll = min(0.004, ring.period / float(rate) / 3.0)
    end = time.monotonic() + 6.0
    try:
        while pos < len(data) and time.monotonic() < end:
            _r, w, lvl = ring.state()
            if wlast is None:
                wlast = w
            new = (w - wlast) % ring.frames
            wlast = w
            use = min(new, lvl)         # nur Ungelesenes
            pos += (new - use) * 4
            part = data[pos:pos + use * 4]
            if part:
                mixer.add((w - use) % ring.frames, part)
                pos += len(part)
                done += len(part) // 4
            time.sleep(poll)
    except RingError as e:
        sys.stderr.write('probe: %s\n' % e)
    finally:
        ring.close()
    sys.stderr.write('probe: %d von %d Frames gemischt\n' % (done, len(data) // 4))
    return 0 if done else 5


def cmd_rings():
    """Alle SmartX-/AVB-Ringpuffer: Aufbau und ob sich gerade etwas bewegt (nur lesen; für die Audio-Diagnose)."""
    d = os.environ.get('ICONIX_SHM_DIR', '/dev/shm')
    out, open_ = [], []
    for n in sorted(os.listdir(d)):
        m = re.match(r'(smartx|avb)_(.+)_p_ringbuffer$', n)
        if not m:
            continue
        try:
            open_.append((m.group(1), m.group(2), Ring(os.path.join(d, n))))
        except Exception as e:
            out.append({'bar': m.group(1), 'name': m.group(2), 'error': str(e)[:80]})
    seen = dict((i, [set(), []]) for i in range(len(open_)))
    end = time.monotonic() + 0.6
    while time.monotonic() < end:
        for i, (_b, _n, r) in enumerate(open_):
            try:
                a, b, lvl = r.state()
                seen[i][0].add(b)
                seen[i][1].append(lvl)
            except RingError:
                pass
        time.sleep(0.004)
    for i, (b, n, r) in enumerate(open_):
        lv = seen[i][1] or [0]
        out.append({'bar': b, 'name': n, 'period': r.period, 'periods': r.periods, 'ch': r.channels, 'fmt': r.code,
                    'alive': len(seen[i][0]) > 1, 'min': min(lv), 'max': max(lv), 'off': r.off, 'size': r.size})
        r.close()
    print(json.dumps({'rings': out}))


if __name__ == '__main__':
    a = sys.argv[1:]
    signal.signal(signal.SIGTERM, on_sigterm)
    try:
        if len(a) >= 3 and a[0] == 'play':
            sys.exit(cmd_play(a[1], int(a[2]), int(a[3]) if len(a) > 3 else 200000, int(a[4]) if len(a) > 4 else 2))
        elif len(a) >= 2 and a[0] == 'mix':
            sys.exit(cmd_mix(a[1], int(a[2]) if len(a) > 2 else 24000))
        elif len(a) >= 3 and a[0] == 'probe':
            sys.exit(cmd_probe(a[1], a[2]))
        elif a and a[0] == 'rings':
            cmd_rings()
        else:
            sys.stderr.write(__doc__)
            sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(0)
    except OSError as e:
        if a and a[0] == 'rings':
            print(json.dumps({'rings': [], 'error': str(e)}))
        else:
            sys.stderr.write('alsa_play: %s\n' % e)
        sys.exit(4)
