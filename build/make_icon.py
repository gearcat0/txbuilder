"""Generate build/icon.png for TX Builder: 'tx' in accent teal on the app bg.

Usage: python3 build/make_icon.py
Requires Pillow. Downloads JetBrains Mono Bold next to this script if missing.
"""
import pathlib
import urllib.request

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
SIZE = 1024
BG = "#08080A"        # evm-ui tokens.bg
ACCENT = "#00E4B8"    # evm-ui tokens.accent
FONT_PATH = HERE / "JetBrainsMono-Bold.ttf"
FONT_URL = "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Bold.ttf"

if not FONT_PATH.exists():
    print("fetching", FONT_URL)
    urllib.request.urlretrieve(FONT_URL, FONT_PATH)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded-square background (macOS-ish squircle radius ~22.5%)
radius = int(SIZE * 0.225)
draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=BG)

# Subtle accent border so the tile reads against dark docks/taskbars.
# Inset a full stroke width so it never overlaps the tile's antialiased edge.
border_w = int(SIZE * 0.010)
inset = border_w * 2
overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(overlay).rounded_rectangle(
    [inset, inset, SIZE - 1 - inset, SIZE - 1 - inset],
    radius=radius - inset,
    outline=(0, 228, 184, 90),
    width=border_w,
)
img = Image.alpha_composite(img, overlay)
draw = ImageDraw.Draw(img)

text = "tx"
font = ImageFont.truetype(str(FONT_PATH), int(SIZE * 0.52))

# Center using ink bounding box (lowercase glyphs sit low otherwise)
bbox = draw.textbbox((0, 0), text, font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
x = (SIZE - w) / 2 - bbox[0]
y = (SIZE - h) / 2 - bbox[1]
draw.text((x, y), text, font=font, fill=ACCENT)

img.save(HERE / "icon.png")
print("wrote", HERE / "icon.png", img.size)
