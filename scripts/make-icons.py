"""Render the PNG app icons from the same shapes as src/icons/icon.svg (needs Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

BG = (11, 15, 26)
CYAN = (34, 211, 238)
PURPLE = (167, 139, 250)
HILL = (20, 28, 48)
OUT = Path(__file__).resolve().parent.parent / "src" / "icons"


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def bezier(p0, p1, p2, p3, n=64):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def render(size, maskable=False):
    s = 4  # supersample
    W = 512 * s
    img = Image.new("RGB", (W, W), BG)
    d = ImageDraw.Draw(img)
    pad = 0.12 if maskable else 0.0  # keep the art inside the maskable safe zone
    k = (1 - 2 * pad) * s
    off = pad * W
    P = lambda x, y: (off + x * k, off + y * k)
    grad = Image.new("RGB", (W, W))
    gd = ImageDraw.Draw(grad)
    for y in range(W):
        gd.line([(0, y), (W, y)], fill=lerp(CYAN, PURPLE, y / W))
    mask = Image.new("L", (W, W), 0)
    md = ImageDraw.Draw(mask)
    cx, cy = P(256, 292)
    r = 124 * k
    md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    img.paste(grad, (0, 0), mask)
    curve = list(bezier((0, 352), (120, 292), (210, 336), (290, 314))) + list(bezier((290, 314), (370, 292), (440, 304), (512, 334)))
    pts = [P(x, y) for x, y in curve]
    if maskable:  # the hill runs to the very edges of a maskable icon
        pts = [(0, pts[0][1])] + pts + [(W, pts[-1][1])]
    d.polygon(pts + [(W, W), (0, W)], fill=HILL)
    line_mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(line_mask).line(pts, fill=255, width=int(14 * k), joint="curve")
    img.paste(grad, (0, 0), line_mask)
    if not maskable:  # rounded corners like the SVG
        corner = Image.new("L", (W, W), 0)
        ImageDraw.Draw(corner).rounded_rectangle([0, 0, W - 1, W - 1], radius=112 * s, fill=255)
        rgba = img.convert("RGBA")
        rgba.putalpha(corner)
        img = rgba
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
render(192).save(OUT / "icon-192.png", optimize=True)
render(512).save(OUT / "icon-512.png", optimize=True)
render(512, maskable=True).save(OUT / "icon-maskable-512.png", optimize=True)
print("icons written to", OUT)
