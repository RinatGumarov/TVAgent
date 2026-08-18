#!/usr/bin/env python3
"""Regenerates extension/icons/*.png.

Everything is drawn at 16x and downsampled with LANCZOS, so the 16px icon —
the one Chrome actually shows in the toolbar — keeps clean edges instead of
the stair-steps you get from drawing a 16px circle directly.

    python3 tools/make-icons.py
"""
from PIL import Image, ImageDraw
import os

SIZES = (16, 32, 48, 128)
SS = 16                      # supersample factor

VIOLET = (124, 92, 255, 255)  # the mark's own colour, deliberately not TV blue
WHITE = (255, 255, 255, 255)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'extension', 'icons')


def draw(size):
    """One icon at `size` px: violet squircle, rising line, agent dot."""
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square. Chrome puts nothing behind the toolbar icon, so the
    # tile is what gives the mark contrast on both light and dark themes.
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 0.22, fill=VIOLET)

    # A rising three-segment line — the chart. Points are fractions of the
    # tile so the shape is identical at every size.
    pts = [(0.22, 0.68), (0.40, 0.50), (0.55, 0.60), (0.78, 0.30)]
    px = [(x * n, y * n) for x, y in pts]
    d.line(px, fill=WHITE, width=int(n * 0.085), joint='curve')

    # The dot at the apex — the agent sitting on top of the chart.
    r = n * 0.105
    cx, cy = px[-1]
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT, 'icon%d.png' % s)
        draw(s).save(path)
        print('%s  %dx%d' % (path, s, s))


if __name__ == '__main__':
    main()
