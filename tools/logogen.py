#!/usr/bin/env python3
"""Apprifi logo generator.

Parametric, vector-first. Every mark is drawn from a few numbers on a 100x100 grid so it stays crisp at
16 px and at 2 m. The wordmark is set in PT Serif Bold and converted to outlines, so the SVG needs no fonts.

    python3 tools/logogen.py sheet            -> tools/out/sheet.png     every concept, for choosing
    python3 tools/logogen.py build <concept>  -> public/apprifi-*.svg, favicons, og image, site copies

Concepts: aframe (the house stands in for the A of the wordmark), checkA, roofbar, houserail, tile, ligature, pin
Palette: navy #12324f, orange #d4652a (override with --navy/--orange).
"""
import sys, os, math, argparse, io
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tools", "out")
FONT = os.environ.get("APPRIFI_FONT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "PTSerif-Bold.ttf"))

def stroke(d, color, w=11, cap="round"):
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="{cap}" stroke-linejoin="round"/>'

# ---------- concepts: each returns SVG inner markup for a 100x100 viewBox ----------
def checkA(navy, orange):
    """An A whose crossbar is a check: the property, verified."""
    legs = stroke("M17 86 L50 15 L83 86", navy, 12.5)
    tick = stroke("M33 59 L47 73 L76 42", orange, 12.5)
    return legs + tick

def roofbar(navy, orange):
    """A roof over a status bar: the order, moving."""
    roof = stroke("M14 50 L50 18 L86 50", navy, 12)
    segs = ""
    x, w, gap, y, h = 20, 16.5, 5.5, 64, 14
    for i in range(3):
        col = navy if i < 2 else orange
        segs += f'<rect x="{x + i*(w+gap):.1f}" y="{y}" width="{w}" height="{h}" rx="4" fill="{col}"/>'
    return roof + segs

def houserail(navy, orange):
    """House outline with the status rail inside."""
    house = stroke("M16 48 L50 18 L84 48 L84 86 L16 86 Z", navy, 10)
    dots = ""
    for i, cy in enumerate((50, 64, 78)):
        col = orange if i == 2 else navy
        dots += f'<circle cx="50" cy="{cy}" r="5.5" fill="{col}"/>'
    rail = stroke("M50 50 L50 78", navy, 3)
    return house + rail + dots

def tile(navy, orange):
    """Navy tile, white roofline A, orange door (the current mark, tightened)."""
    return (f'<rect x="4" y="4" width="92" height="92" rx="22" fill="{navy}"/>'
            f'<path d="M50 20 L22 48 H33 V78 H67 V48 H78 Z" fill="#fff"/>'
            f'<rect x="44" y="58" width="12" height="20" rx="2.5" fill="{orange}"/>')

def ligature(navy, orange):
    """A whose right leg becomes a check."""
    a = stroke("M16 84 L44 18 L58 52", navy, 12)
    tick = stroke("M42 62 L58 78 L88 40", orange, 12)
    return a + tick

def pin(navy, orange):
    """A property pin with a roofline."""
    body = (f'<path d="M50 92 C50 92 22 62 22 42 A28 28 0 0 1 78 42 C78 62 50 92 50 92 Z" fill="{navy}"/>')
    roof = stroke("M34 48 L50 32 L66 48", "#fff", 8)
    door = f'<rect x="45" y="48" width="10" height="16" rx="2" fill="{orange}"/>'
    return body + roof + door

def aframe(navy, orange):
    """An A-frame house: steep rafters to the ground, a loft beam as the crossbar, a glazed gable window above it, a plank door below."""
    # gable window: the triangle between the rafters' inner edges and the beam, glazed, with a mullion cross
    window = (f'<polygon points="50,18 27,60 73,60" fill="#dfeaf3"/>'
              f'<path d="M50 30 L50 60 M36 47 L64 47" stroke="{navy}" stroke-width="2.6" stroke-linecap="round" opacity=".9"/>')
    rafters = stroke("M14 88 L50 14 L86 88", navy, 17)
    beam = stroke("M30 60 L70 60", navy, 14, cap="butt")
    # plank door: wood tones, two grooves, a knob
    door = (f'<defs><linearGradient id="wood" x1="0" y1="0" x2="1" y2="0">'
            f'<stop offset="0" stop-color="#c9743a"/><stop offset=".5" stop-color="{orange}"/><stop offset="1" stop-color="#b85d24"/></linearGradient></defs>'
            f'<rect x="41" y="69" width="18" height="27" rx="3" fill="url(#wood)"/>'
            f'<path d="M47 71.5 V94 M53 71.5 V94" stroke="#9a4a1a" stroke-width="1.4" opacity=".75"/>'
            f'<circle cx="55.5" cy="83" r="1.6" fill="#f6e3c8"/>')
    return window + rafters + beam + door

CONCEPTS = {"aframe": aframe, "checkA": checkA, "roofbar": roofbar, "houserail": houserail, "tile": tile, "ligature": ligature, "pin": pin}

def mark_svg(concept, navy, orange, size=100, bg=None, pad=0):
    inner = CONCEPTS[concept](navy, orange)
    bgrect = f'<rect width="100" height="100" rx="22" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="{-pad} {-pad} {100+2*pad} {100+2*pad}" role="img" aria-label="Apprifi">'
            f'{bgrect}{inner}</svg>')

# ---------- wordmark as outlines ----------
CAP = 712 / 1000  # PT Serif Bold cap height, em units
def wordmark_path(text="Apprifi", size=100, tracking=-0.5):
    """Returns (path_d, advance_width) for text set at `size` px, baseline at y=0, using PT Serif Bold outlines."""
    font = TTFont(FONT)
    cmap = font.getBestCmap(); gs = font.getGlyphSet(); upem = font["head"].unitsPerEm
    scale = size / upem
    x = 0.0; parts = []
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[gname].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))  # flip y for SVG
        parts.append(pen.getCommands())
        x += gs[gname].width * scale + tracking
    return " ".join(parts), x - tracking

def lockup_house_svg(navy, orange, text_color=None, size=34, h=40):
    """The A-frame house stands in for the capital A of the wordmark: house, then "pprifi" in outlines."""
    text_color = text_color or navy
    d, adv = wordmark_path("pprifi", size=size, tracking=-0.4)
    cap = size * CAP
    # the house's 100-grid spans y 6..96 (stroke included); scale so that span equals the cap height plus a hair
    s = (cap * 1.1) / 92
    baseline = (h + cap) / 2
    house_w = 100 * s
    top = baseline - 96.5 * s  # the rafters' feet (grid y 96.5, stroke included) stand on the baseline
    gap = size * 0.04
    w = house_w + gap + adv + 1
    inner = aframe(navy, orange)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h}" viewBox="0 0 {w:.1f} {h}" role="img" aria-label="Apprifi">'
            f'<title>Apprifi</title>'
            f'<g transform="translate(0 {top:.2f}) scale({s:.4f})">{inner}</g>'
            f'<path transform="translate({house_w+gap:.2f} {baseline:.2f})" d="{d}" fill="{text_color}"/></svg>')

def lockup_svg(concept, navy, orange, text_color=None, mark=40, gap=12, size=None):
    """Horizontal lockup: mark at `mark` px tall, wordmark to its right, baseline aligned."""
    text_color = text_color or navy
    d, adv = wordmark_path("Apprifi", size=mark * 0.86)
    # PT Serif ascender ~0.7 of size; place baseline so caps align with the mark's visual centre
    cap = mark * 0.86 * 0.70
    baseline = (mark + cap) / 2 + 1
    w = mark + gap + adv + 2; h = mark
    inner = CONCEPTS[concept](navy, orange)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h}" viewBox="0 0 {w:.1f} {h}" role="img" aria-label="Apprifi">'
            f'<title>Apprifi</title>'
            f'<g transform="scale({mark/100:.4f})">{inner}</g>'
            f'<path transform="translate({mark+gap:.1f} {baseline:.2f})" d="{d}" fill="{text_color}"/></svg>')

def png(svg, path, width):
    import cairosvg
    cairosvg.svg2png(bytestring=svg.encode(), write_to=path, output_width=width)

def sheet(navy, orange):
    os.makedirs(OUT, exist_ok=True)
    from PIL import Image, ImageDraw
    cols = 3; cell = 360; rows = math.ceil(len(CONCEPTS) / cols)
    board = Image.new("RGB", (cols * cell, rows * cell), "white"); draw = ImageDraw.Draw(board)
    for i, name in enumerate(CONCEPTS):
        # light: lockup on white; dark: mark on navy; tiny: 24 px favicon size, scaled up nearest to judge legibility
        lock = os.path.join(OUT, f"lock-{name}.png"); png(lockup_svg(name, navy, orange, mark=56), lock, 300)
        mk = os.path.join(OUT, f"mark-{name}.png"); png(mark_svg(name, "#ffffff", orange, bg=navy), mk, 96)
        tiny = os.path.join(OUT, f"tiny-{name}.png"); png(mark_svg(name, navy, orange), tiny, 24)
        x0, y0 = (i % cols) * cell, (i // cols) * cell
        def flat(pth):
            im = Image.open(pth).convert("RGBA"); bg = Image.new("RGBA", im.size, "white"); bg.alpha_composite(im); return bg.convert("RGB")
        board.paste(flat(lock), (x0 + 20, y0 + 30))
        board.paste(flat(mk), (x0 + 20, y0 + 130))
        board.paste(flat(tiny).resize((72, 72), Image.NEAREST), (x0 + 140, y0 + 142))
        draw.rectangle([x0, y0, x0 + cell - 1, y0 + cell - 1], outline="#dde2e8")
        draw.text((x0 + 20, y0 + 300), name + "   " + CONCEPTS[name].__doc__.strip(), fill="#22303f")
    p = os.path.join(OUT, "sheet.png"); board.save(p); print("wrote", p)

def build(concept, navy, orange):
    pub = os.path.join(ROOT, "public"); site = os.path.join(ROOT, "site", "public")
    house = concept == "aframe"
    files = {
        "apprifi-logo.svg": lockup_house_svg(navy, orange) if house else lockup_svg(concept, navy, orange, mark=40),
        "apprifi-logo-white.svg": lockup_house_svg("#ffffff", orange, text_color="#ffffff") if house else lockup_svg(concept, "#ffffff", orange, text_color="#ffffff", mark=40),
        "apprifi-mark.svg": mark_svg(concept, navy, orange, size=40),
        "apprifi-mark-tile.svg": mark_svg(concept, "#ffffff", orange, size=40, bg=navy),
    }
    for d in (pub, site):
        for name, svg in files.items():
            with open(os.path.join(d, name), "w") as f: f.write(svg)
        png(mark_svg(concept, "#ffffff", orange, bg=navy), os.path.join(d, "favicon.png"), 64)
        png(mark_svg(concept, "#ffffff", orange, bg=navy), os.path.join(d, "apple-touch-icon.png"), 180)
    print("built", concept, "into public/ and site/public/")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["sheet", "build"]); ap.add_argument("concept", nargs="?")
    ap.add_argument("--navy", default="#12324f"); ap.add_argument("--orange", default="#d4652a")
    a = ap.parse_args()
    if a.cmd == "sheet": sheet(a.navy, a.orange)
    else:
        if a.concept not in CONCEPTS: sys.exit("concept must be one of " + ", ".join(CONCEPTS))
        build(a.concept, a.navy, a.orange)
