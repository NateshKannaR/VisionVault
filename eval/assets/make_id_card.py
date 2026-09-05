"""
make_id_card.py — generates the hardest thing this detector has to see.

An Aadhaar card as a photograph: the number exists only as pixels, and it is printed twice,
once in Latin digits and once in Devanagari. That combination is the realistic worst case and
also the likeliest thing a panel will try, because it defeats two different shortcuts at once:

  * a DOM scanner sees nothing, because there is no text node, input or attribute involved; and
  * an OCR pipeline whose patterns are written in [0-9] reads the Devanagari line perfectly
    well and then matches none of it, so the page looks clean rather than looking broken.

Alongside the PNG it writes id-card-boxes.json with the pixel box of each sensitive line, so
the gauntlet fixture can mark ground truth without anyone measuring by hand.

Run:  python eval/assets/make_id_card.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
WIDTH, HEIGHT = 640, 300

# A real Aadhaar never begins with 0 or 1, and the detector relies on that to avoid masking
# every twelve-digit order number. A fixture that used 1234 5678 9012 would therefore be
# testing the wrong thing and would "pass" against a detector that had regressed.
AADHAAR_LATIN = "2345 6789 0123"
AADHAAR_DEVANAGARI = "२३४५ ६७८९ ०१२३"
DOB = "14/03/1998"
VID = "9123 4567 8901 2345"


def load_font(size, bold=False, devanagari=False):
    """A font that can actually draw the glyphs asked of it.

    Devanagari is the awkward case: the default PIL font and most Latin faces render the
    digits as empty boxes, which would produce a fixture that silently tests nothing.
    """
    if devanagari:
        candidates = [
            "C:/Windows/Fonts/Nirmala.ttf",
            "C:/Windows/Fonts/mangal.ttf",
            "/usr/share/fonts/truetype/lohit-devanagari/Lohit-Devanagari.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    else:
        candidates = [
            "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/consolab.ttf" if bold else "C:/Windows/Fonts/consola.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
            else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def can_render(font, text):
    """Whether the font draws `text` as glyphs rather than as a row of empty boxes."""
    probe = Image.new("L", (200, 60), 0)
    ImageDraw.Draw(probe).text((4, 4), text, font=font, fill=255)
    return probe.getbbox() is not None


def main():
    img = Image.new("RGB", (WIDTH, HEIGHT), (247, 245, 238))
    d = ImageDraw.Draw(img)

    # Card furniture, so the image reads as a document rather than as a screenshot of text.
    d.rectangle([0, 0, WIDTH - 1, 58], fill=(255, 153, 51))
    d.rectangle([0, HEIGHT - 34, WIDTH - 1, HEIGHT - 1], fill=(19, 136, 8))
    d.rectangle([0, 0, WIDTH - 1, HEIGHT - 1], outline=(120, 116, 104), width=2)

    title = load_font(20, bold=True)
    body = load_font(19)
    small = load_font(14)
    deva = load_font(30, devanagari=True)

    d.text((16, 18), "GOVERNMENT OF INDIA", font=title, fill=(70, 40, 0))

    # The photograph slot. A flat rectangle rather than a real face: face coverage is exercised
    # by the feed fixture, and a detector should mask this because of what is written beside
    # it, not because it found a face.
    d.rectangle([20, 78, 132, 218], fill=(206, 212, 218), outline=(150, 150, 150))
    d.text((38, 140), "PHOTO", font=small, fill=(110, 110, 110))

    boxes = []

    def line(x, y, text, font, sensitive, kind=None):
        d.text((x, y), text, font=font, fill=(25, 25, 25))
        if sensitive:
            l, t, r, b = d.textbbox((x, y), text, font=font)
            boxes.append({"type": kind, "text": text,
                          "x": int(l) - 3, "y": int(t) - 3,
                          "w": int(r - l) + 6, "h": int(b - t) + 6})

    line(152, 82, "Priya Raghavan", body, True, "name")
    line(152, 112, f"DOB: {DOB}", small, True, "dob")

    # The same number twice. If only one of these is masked the redaction is not complete, and
    # the fixture is built so that the failure is visible rather than averaged away.
    line(152, 140, AADHAAR_LATIN, load_font(26, bold=True), True, "aadhaar_latin")

    if can_render(deva, AADHAAR_DEVANAGARI):
        line(152, 174, AADHAAR_DEVANAGARI, deva, True, "aadhaar_devanagari")
    else:
        # Better to ship a fixture that says what is missing than one that quietly tests less
        # than it claims.
        print("  ! no Devanagari-capable font found; the Devanagari line is omitted")

    line(152, 218, f"VID: {VID}", small, True, "vid")
    d.text((16, HEIGHT - 27), "Aadhaar - Aam Aadmi ka Adhikar", font=small, fill=(240, 255, 240))

    png = os.path.join(OUT_DIR, "id-card.png")
    img.save(png)
    with open(os.path.join(OUT_DIR, "id-card-boxes.json"), "w", encoding="utf-8") as f:
        json.dump({"width": WIDTH, "height": HEIGHT, "regions": boxes}, f, indent=2)

    print(f"wrote {png} ({WIDTH}x{HEIGHT}) with {len(boxes)} ground-truth region(s)")
    for b in boxes:
        # A Windows console is cp1252 and cannot encode Devanagari, which is precisely the
        # text this fixture exists to carry. Print an ASCII stand-in rather than crashing
        # after the PNG has already been written.
        text = b["text"]
        try:
            text.encode(os.sys.stdout.encoding or "utf-8")
        except (UnicodeEncodeError, LookupError):
            text = f"<{len(text)} non-ASCII chars>"
        print(f"  {b['type']:<20} {text}")


if __name__ == "__main__":
    main()
