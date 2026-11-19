#!/usr/bin/env python3
"""Genera Kaito.icns (cuadrado redondeado con degradado y una «K» dibujada con polígonos, sin fuentes).
Uso: python3 make-icon.py  (necesita Pillow; escribe Kaito.icns y Kaito-1024.png junto a este script)."""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
S = 4  # supersampling para suavizar bordes
N = 1024 * S


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def icon():
    top, bottom = (0x5B, 0xC8, 0xAF), (0x1F, 0x6F, 0x86)
    grad = Image.new("RGB", (1, N))
    for y in range(N):
        grad.putpixel((0, y), lerp(top, bottom, y / (N - 1)))
    grad = grad.resize((N, N))
    m, r = 100 * S, 185 * S  # margen y radio de la plantilla de iconos de macOS
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle((m, m, N - m, N - m), radius=r, fill=255)
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    # «K»: barra vertical + dos diagonales que se juntan en la barra.
    x0, y0, y1, w = 330 * S, 290 * S, 734 * S, 110 * S
    d.rectangle((x0, y0, x0 + w, y1), fill=white)
    mid = (y0 + y1) // 2
    d.polygon([(x0 + w - 10 * S, mid + 40 * S), (x0 + w - 10 * S, mid - 110 * S), (650 * S, y0), (790 * S, y0)], fill=white)
    d.polygon([(x0 + w + 40 * S, mid - 30 * S), (x0 + w + 115 * S, mid - 105 * S), (800 * S, y1), (655 * S, y1)], fill=white)
    return img.resize((1024, 1024), Image.LANCZOS)


if __name__ == "__main__":
    im = icon()
    im.save(os.path.join(HERE, "Kaito-1024.png"))
    im.save(os.path.join(HERE, "Kaito.icns"), sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    print("Kaito.icns y Kaito-1024.png generados")
