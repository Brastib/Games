"""
Erzeugt das Bot-Icon "ETC. Bot" aus der Spiele-Collage.
Die Collage bleibt erhalten; in der Mitte kommt eine abgedunkelte, unscharfe Platte mit
gut lesbarem "ETC." und einem roten "BOT"-Schild (StandBy-Rot #FD0000).

Aufruf:  python3 scripts/make-icon.py <collage.webp|png> <ausgabe-ordner>
Ergebnis: etc-bot.png (1024 px), etc-bot-512.png, etc-bot-256.png, vorschau.png
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RED = (253, 0, 0)
SIZE = 1024
FONTS = Path(__file__).resolve().parent.parent / 'assets' / 'fonts'


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def text_size(draw, text, font, spacing=0):
    if spacing:
        w = sum(draw.textlength(ch, font=font) for ch in text) + spacing * (len(text) - 1)
    else:
        w = draw.textlength(text, font=font)
    box = draw.textbbox((0, 0), text, font=font)
    return w, box[3] - box[1], box[1]


def make(src, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = Image.open(src).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
    # ganz leichte Schärfung nach dem Vergrößern
    base = base.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))

    # --- Platte in der Mitte: unscharf + abgedunkelt, roter Rand ---
    pw, ph, pr = 740, 450, 70
    px, py = (SIZE - pw) // 2, (SIZE - ph) // 2 - 6
    region = base.crop((px, py, px + pw, py + ph)).filter(ImageFilter.GaussianBlur(14))
    dark = Image.new('RGB', region.size, (0, 0, 0))
    region = Image.blend(region, dark, 0.62)
    base.paste(region, (px, py), rounded_mask((pw, ph), pr))

    # weicher Schatten um die Platte, damit sie sich vom bunten Hintergrund abhebt
    shadow = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([px - 6, py - 6, px + pw + 6, py + ph + 6], radius=pr + 6, outline=200, width=22)
    shadow = shadow.filter(ImageFilter.GaussianBlur(16))
    base = Image.composite(Image.new('RGB', base.size, (0, 0, 0)), base, shadow.point(lambda v: int(v * 0.55)))

    d = ImageDraw.Draw(base)
    d.rounded_rectangle([px, py, px + pw - 1, py + ph - 1], radius=pr, outline=RED, width=10)

    # --- "ETC." groß und weiß mit schwarzer Kontur ---
    f_big = ImageFont.truetype(str(FONTS / 'Poppins-ExtraBold.ttf'), 250)
    w, h, top = text_size(d, 'ETC.', f_big)
    tx = (SIZE - w) / 2
    ty = py + 46 - top
    d.text((tx + 8, ty + 10), 'ETC.', font=f_big, fill=(0, 0, 0))  # Schatten
    d.text((tx, ty), 'ETC.', font=f_big, fill=(255, 255, 255), stroke_width=7, stroke_fill=(0, 0, 0))

    # --- rotes "BOT"-Schild darunter ---
    f_bot = ImageFont.truetype(str(FONTS / 'Poppins-ExtraBold.ttf'), 104)
    spacing = 14
    bw, bh, btop = text_size(d, 'BOT', f_bot, spacing)
    pill_w, pill_h = int(bw + 110), 140
    pill_x = (SIZE - pill_w) // 2
    pill_y = py + ph - pill_h - 44
    d.rounded_rectangle([pill_x, pill_y, pill_x + pill_w, pill_y + pill_h], radius=pill_h // 2, fill=RED)
    x = (SIZE - bw) / 2
    y = pill_y + (pill_h - bh) / 2 - btop
    for ch in 'BOT':
        d.text((x, y), ch, font=f_bot, fill=(0, 0, 0))
        x += d.textlength(ch, font=f_bot) + spacing

    base.save(out_dir / 'etc-bot.png', optimize=True)
    base.resize((512, 512), Image.LANCZOS).save(out_dir / 'etc-bot-512.png', optimize=True)
    base.resize((256, 256), Image.LANCZOS).save(out_dir / 'etc-bot-256.png', optimize=True)
    base.resize((180, 180), Image.LANCZOS).save(out_dir / 'apple-touch-icon.png', optimize=True)
    base.resize((64, 64), Image.LANCZOS).save(out_dir / 'favicon.png', optimize=True)

    # --- Vorschau: so sieht es in Discord aus (rund, auf dunklem Hintergrund, verschiedene Größen) ---
    prev = Image.new('RGB', (1100, 420), (49, 51, 56))
    pd = ImageDraw.Draw(prev)
    xpos = 30
    for s in (320, 128, 80, 40):
        av = base.resize((s, s), Image.LANCZOS)
        m = Image.new('L', (s * 4, s * 4), 0)
        ImageDraw.Draw(m).ellipse([0, 0, s * 4 - 1, s * 4 - 1], fill=255)
        m = m.resize((s, s), Image.LANCZOS)
        prev.paste(av, (xpos, (420 - s) // 2), m)
        pd.text((xpos, 400 - 6), f'{s}px', fill=(181, 186, 193))
        xpos += s + 60
    prev.save(out_dir / 'vorschau.png')
    return out_dir


if __name__ == '__main__':
    print(make(sys.argv[1], sys.argv[2]))
