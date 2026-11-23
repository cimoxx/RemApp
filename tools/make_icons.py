# Vygeneruje ikony aplikácie: python3 tools/make_icons.py icons  (vyžaduje Pillow)
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
S = 4

def draw(size, maskable=False, rounded=True):
    W = 512 * S
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    # gradient pozadie (Flow accent #10b981 -> #059669)
    grad = Image.new('RGBA', (W, W))
    gd = ImageDraw.Draw(grad)
    top, bot = (52, 211, 153), (5, 150, 105)
    for y in range(W):
        t = y / W
        gd.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
    mask = Image.new('L', (W, W), 0)
    md = ImageDraw.Draw(mask)
    if maskable or not rounded:
        md.rectangle([0, 0, W, W], fill=255)
    else:
        md.rounded_rectangle([0, 0, W - 1, W - 1], radius=112 * S, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    k = 0.62 if maskable else 0.82          # zmenšenie piktogramu (maskable safe zone)
    off = 256 * (1 - k)
    P = lambda x, y: ((off + x * k) * S, (off + y * k) * S)
    white = (255, 255, 255, 255)
    lw = int(34 * k * S)
    # rúčka
    d.line([P(70, 120), P(130, 120), P(165, 175)], fill=white, width=lw, joint='curve')
    for x, y in [(70, 120)]:
        r = lw / 2
        cx, cy = P(x, y)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=white)
    # košík
    d.rounded_rectangle([P(150, 165), P(450, 345)], radius=int(40 * k * S), fill=white)
    # odškrtnutie v košíku
    green = (5, 150, 105, 255)
    d.line([P(240, 255), P(285, 298), P(365, 210)], fill=green, width=int(30 * k * S), joint='curve')
    for x, y in [(240, 255), (365, 210)]:
        r = 15 * k * S
        cx, cy = P(x, y)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=green)
    # kolieska
    for x in (215, 390):
        r = 30 * k * S
        cx, cy = P(x, 405)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=white)
    return img.resize((size, size), Image.LANCZOS)

draw(192).save(f'{out}/icon-192.png')
draw(512).save(f'{out}/icon-512.png')
draw(512, maskable=True).save(f'{out}/icon-maskable-512.png')
draw(180, rounded=False).convert('RGB').save(f'{out}/apple-touch-icon.png')
print('ok')
