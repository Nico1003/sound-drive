#!/usr/bin/env python3
"""Hängt die deutschen Zeichen (Umlaute, ß, Anführungszeichen) an die Schriften in kit/runtime/fonts an.

  python kit/tools/bake_german.py path/to/Ubuntu[wdth,wght].ttf      (braucht Pillow; die Schrift liegt z. B. im Paket fonts-ubuntu)

Die Zeichen, die es schon gibt, bleiben unverändert: gleiche Pixel, gleicher Platz. Die neuen stehen in Zeilen darunter
("split" = erste neue Zeile). Im GPU-Renderer sind es zwei Texturen: die alte (gleiche Kennung wie bei jeder anderen App,
wird also geteilt) und die kleine neue (siehe fonts.js pieces). Das Ergebnis liegt im Repo; der Bau braucht das hier nicht.
"""
import base64
import json
import os
import sys
import zlib

from PIL import Image, ImageDraw, ImageFont

FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'runtime', 'fonts')
NEW = 'ÄÖÜäöüß„“”‚‘’−à'
AXES = {'label': (85, 400), 'bold': (85, 700), 'num': (75, 500), 'light': (85, 300)}      # Breite, Stärke wie die vorhandenen


def load(ttf, axes, size):
    f = ImageFont.truetype(ttf, size)
    f.set_variation_by_axes(list(axes))
    return f


def advance(ttf, axes, size, ch):
    # ohne raqm rundet Pillow auf ganze Pixel: groß messen
    return load(ttf, axes, size * 32).getlength(ch) / 32.0


def glyph(font, ch):
    b = font.getbbox(ch, anchor='ls')
    w, h = b[2] - b[0], b[3] - b[1]
    im = Image.new('L', (w, h), 0)
    ImageDraw.Draw(im).text((-b[0], -b[1]), ch, font=font, fill=255, anchor='ls')
    return im, b


def main():
    ttf = sys.argv[1]
    for family, axes in AXES.items():
        p = os.path.join(FONTS, family + '.json')
        data = json.load(open(p, encoding='utf-8'))
        for s in data['sizes']:
            if str(ord('y')) not in s['glyphs']:
                continue                        # nur Ziffern
            size, W = s['size'], s['atlasW']
            H = s.get('split', s['atlasH'])
            alpha = zlib.decompress(base64.b64decode(s['alpha']))[:W * H]
            glyphs = {k: g for k, g in s['glyphs'].items() if g[1] < H}
            font = load(ttf, axes, size)
            old = Image.frombytes('L', (W, H), alpha)
            for ch in 'aAgW8':      # dieselbe Schrift in derselben Einstellung?
                x, y, w, h, ox, oy, adv = glyphs[str(ord(ch))]
                im, b = glyph(font, ch)
                same = im.size == (w, h) and (b[0], b[1]) == (ox, oy) and im.tobytes() == old.crop((x, y, x + w, y + h)).tobytes()
                off = abs(advance(ttf, axes, size, ch) - adv)
                if not same or off > 0.06:
                    print('  Achtung: %s %d %r weicht ab (Pixel gleich: %s, Breite %.3f)' % (family, size, ch, same, off))
            x, y, rowh, put = 0, H, 0, []
            for ch in NEW:
                im, b = glyph(font, ch)
                if x + im.width > W:
                    x, y, rowh = 0, y + rowh + 1, 0
                put.append((im, x, y))
                glyphs[str(ord(ch))] = [x, y, im.width, im.height, b[0], b[1], round(advance(ttf, axes, size, ch), 2)]
                x, rowh = x + im.width + 1, max(rowh, im.height)
            full = Image.new('L', (W, y + rowh + 1), 0)
            full.paste(old, (0, 0))
            for im, px, py in put:
                full.paste(im, (px, py))
            s.update({'split': H, 'atlasH': full.height, 'glyphs': glyphs, 'alpha': base64.b64encode(zlib.compress(full.tobytes(), 9)).decode()})
            print('%s %d: %d -> %d Zeilen' % (family, size, H, full.height))
        json.dump(data, open(p, 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))


if __name__ == '__main__':
    main()
