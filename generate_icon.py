"""
MirrorSim app icon generator.
1024x1024 PNG, transparent outer background.
Dark charcoal rounded-square, cyan smartphone outline, AirPlay-style glow.
"""
import math
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- Rounded square background ---
BG_RADIUS = 200
BG_COLOR = (28, 30, 35, 255)          # dark charcoal
BG_MARGIN = 0

def rounded_rect_mask(size, radius, margin=0):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = margin
    d.rounded_rectangle([r, r, size - r - 1, size - r - 1], radius=radius, fill=255)
    return mask

bg_mask = rounded_rect_mask(SIZE, BG_RADIUS, BG_MARGIN)
bg_layer = Image.new("RGBA", (SIZE, SIZE), BG_COLOR)
img.paste(bg_layer, mask=bg_mask)

# --- Phone outline parameters ---
# Phone sits centered, generous padding
PH_W = 280          # phone body width
PH_H = 480          # phone body height
PH_R = 52           # phone corner radius
PH_STROKE = 14      # stroke thickness
PH_X = (SIZE - PH_W) // 2
PH_Y = (SIZE - PH_H) // 2

CYAN = (0, 220, 255)
CYAN_DIM = (0, 170, 210)

# Glow behind the phone outline (multi-pass blur)
glow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow_layer)
# outer glow rect slightly larger
G_PAD = 28
gd.rounded_rectangle(
    [PH_X - G_PAD, PH_Y - G_PAD, PH_X + PH_W + G_PAD, PH_Y + PH_H + G_PAD],
    radius=PH_R + G_PAD,
    outline=(0, 220, 255, 80),
    width=PH_STROKE + G_PAD,
)
glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=24))
img = Image.alpha_composite(img, glow_layer)

# Softer inner glow pass
glow2 = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd2 = ImageDraw.Draw(glow2)
gd2.rounded_rectangle(
    [PH_X - 12, PH_Y - 12, PH_X + PH_W + 12, PH_Y + PH_H + 12],
    radius=PH_R + 12,
    outline=(0, 220, 255, 120),
    width=PH_STROKE + 12,
)
glow2 = glow2.filter(ImageFilter.GaussianBlur(radius=12))
img = Image.alpha_composite(img, glow2)

draw = ImageDraw.Draw(img)

# Phone body fill (very dark, slightly bluish)
draw.rounded_rectangle(
    [PH_X, PH_Y, PH_X + PH_W, PH_Y + PH_H],
    radius=PH_R,
    fill=(18, 22, 30, 255),
)

# Phone outline stroke
draw.rounded_rectangle(
    [PH_X, PH_Y, PH_X + PH_W, PH_Y + PH_H],
    radius=PH_R,
    outline=CYAN,
    width=PH_STROKE,
)

# --- Screen area inside phone ---
SCREEN_PAD_X = 28
SCREEN_PAD_TOP = 60
SCREEN_PAD_BOT = 70
SC_X = PH_X + SCREEN_PAD_X
SC_Y = PH_Y + SCREEN_PAD_TOP
SC_W = PH_W - SCREEN_PAD_X * 2
SC_H = PH_H - SCREEN_PAD_TOP - SCREEN_PAD_BOT
SC_R = 18

# Screen fill: subtle gradient-like dark blue
draw.rounded_rectangle(
    [SC_X, SC_Y, SC_X + SC_W, SC_Y + SC_H],
    radius=SC_R,
    fill=(12, 28, 48, 255),
)

# Screen inner glow overlay
sc_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
sg = ImageDraw.Draw(sc_glow)
sg.rounded_rectangle(
    [SC_X, SC_Y, SC_X + SC_W, SC_Y + SC_H],
    radius=SC_R,
    fill=(0, 160, 220, 35),
)
sc_glow = sc_glow.filter(ImageFilter.GaussianBlur(radius=8))
img = Image.alpha_composite(img, sc_glow)

draw = ImageDraw.Draw(img)

# Screen border (thin cyan)
draw.rounded_rectangle(
    [SC_X, SC_Y, SC_X + SC_W, SC_Y + SC_H],
    radius=SC_R,
    outline=(0, 160, 210, 180),
    width=3,
)

# --- AirPlay / cast symbol inside screen ---
# Centered in the screen area
CX = SC_X + SC_W // 2
CY = SC_Y + SC_H // 2 - 10

# AirPlay: concentric arcs + upward triangle
# Three arcs of increasing radius
ARC_COLOR = (0, 220, 255, 220)
ARC_DIM = (0, 180, 230, 140)

for i, (r, alpha, w) in enumerate([(22, 255, 3), (40, 200, 3), (58, 150, 3)]):
    arc_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc_img)
    ad.arc(
        [CX - r, CY - r, CX + r, CY + r],
        start=210, end=330,
        fill=(0, 220, 255, alpha),
        width=w,
    )
    img = Image.alpha_composite(img, arc_img)

draw = ImageDraw.Draw(img)

# Triangle pointing up (signal source dot + stem)
TRI_W = 18
TRI_H = 22
TRI_Y_BASE = CY + 30
tri_pts = [
    (CX, TRI_Y_BASE - TRI_H),
    (CX - TRI_W, TRI_Y_BASE),
    (CX + TRI_W, TRI_Y_BASE),
]
draw.polygon(tri_pts, fill=(0, 220, 255, 230))

# Small horizontal base bar under triangle
BAR_W = 40
BAR_H = 6
BAR_Y = TRI_Y_BASE + 4
draw.rounded_rectangle(
    [CX - BAR_W // 2, BAR_Y, CX + BAR_W // 2, BAR_Y + BAR_H],
    radius=3,
    fill=(0, 220, 255, 200),
)

# --- Home indicator bar at bottom of phone ---
BAR_IND_W = 80
BAR_IND_H = 6
BAR_IND_R = 3
BI_X = PH_X + (PH_W - BAR_IND_W) // 2
BI_Y = PH_Y + PH_H - SCREEN_PAD_BOT // 2 - BAR_IND_H // 2
draw.rounded_rectangle(
    [BI_X, BI_Y, BI_X + BAR_IND_W, BI_Y + BAR_IND_H],
    radius=BAR_IND_R,
    fill=(0, 180, 220, 160),
)

# --- Notch / dynamic island at top of phone ---
NI_W = 60
NI_H = 12
NI_R = 6
NI_X = PH_X + (PH_W - NI_W) // 2
NI_Y = PH_Y + SCREEN_PAD_TOP // 2 - NI_H // 2 + 4
draw.rounded_rectangle(
    [NI_X, NI_Y, NI_X + NI_W, NI_Y + NI_H],
    radius=NI_R,
    fill=(0, 160, 210, 180),
)

# --- Subtle highlight on top-left of background ---
hl = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.ellipse([40, 40, 320, 220], fill=(80, 130, 180, 18))
hl = hl.filter(ImageFilter.GaussianBlur(radius=60))
# mask it to the background shape
hl.putalpha(Image.fromarray(
    __import__("numpy").array(hl.split()[3]) *
    __import__("numpy").array(bg_mask) // 255
))
img = Image.alpha_composite(img, hl)

img.save("app-icon.png", "PNG")
print("app-icon.png saved (1024x1024 RGBA)")
