"""Access Review banners, in the same family as the other TELCOMA apps: navy, the app icon on the
left, the name and two lines on the right, a short line in the Jira blue.

The icon is logo-1024.png in this folder: the shield with a check mark that is on the Marketplace
(a copy of app-icons/png/access-review-jira-1024.png; logo-144 and logo-512 are copies too).
Run: python3 build_assets.py  (needs Pillow; writes the two banners next to this file)"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
NAVY = (11, 34, 57)
WHITE = (255, 255, 255)
GREY = (214, 222, 232)
MUTED = (150, 170, 192)
BLUE = (35, 70, 224)  # TELCOMA blue, used for the Jira apps
LIGHT = (150, 180, 255)
S = 2  # supersampling

TITLE = 'Access Review'
PRODUCT = 'for Jira'
LINES = ['Who has access, reviewed and signed off.', 'Evidence for SOC 2 and ISO 27001.']
FOOTER = 'READ-ONLY  ·  RUNS ON ATLASSIAN  ·  NO EXTERNAL SERVERS'


def font(bold, px):
    for name in (['Arial Bold.ttf'] if bold else []) + ['Arial.ttf']:
        p = f'/System/Library/Fonts/Supplemental/{name}'
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return ImageFont.load_default()


def fitted(d, lines, bold, px, room):
    """The font at px, made smaller until the widest line fits in room."""
    while px > 10:
        f = font(bold, px)
        if max(d.textlength(t, font=f) for t in lines) <= room:
            return f
        px -= 1
    return font(bold, px)


def banner(w, h):
    n_w, n_h = w * S, h * S
    im = Image.new('RGB', (n_w, n_h), NAVY)
    d = ImageDraw.Draw(im)
    for x in range(-n_h, n_w, 9 * S):  # faint diagonal texture
        d.line((x, n_h, x + n_h, 0), fill=(16, 41, 66), width=S)
    # The 1920x1200 banner is taller than the 1120x548 design, so scale by width there:
    # scaled by height alone, the text ran off the right edge.
    u = min(n_h / 548, n_w / 1120)
    size = int(250 * u)
    icon = Image.open(os.path.join(HERE, 'logo-1024.png')).convert('RGBA').resize((size, size), Image.LANCZOS)
    gx = int(n_w * 0.11)
    im.paste(icon, (gx, int(n_h / 2 - size / 2)), icon)
    tx = gx + size + int(70 * u)
    room = n_w - tx - int(56 * u)
    y = n_h * 0.31
    d.text((tx, y), TITLE, font=fitted(d, [TITLE], True, int(60 * u), room), fill=WHITE)
    y += n_h * 0.12
    d.text((tx, y + n_h * 0.005), PRODUCT, font=fitted(d, [PRODUCT], False, int(38 * u), room), fill=LIGHT)
    lf = fitted(d, LINES, False, int(27 * u), room)
    d.text((tx, n_h * 0.61), LINES[0], font=lf, fill=GREY)
    d.text((tx, n_h * 0.67), LINES[1], font=lf, fill=GREY)
    d.rectangle((tx, n_h * 0.76, tx + 72 * u, n_h * 0.76 + 5 * u), fill=BLUE)
    d.text((tx, n_h * 0.80), FOOTER, font=fitted(d, [FOOTER], False, int(16 * u), room), fill=MUTED)
    return im.resize((w, h), Image.LANCZOS)


banner(1120, 548).save(os.path.join(HERE, 'banner-1120x548.png'))
banner(1920, 1200).save(os.path.join(HERE, 'banner-1920x1200.png'))
print('done')
