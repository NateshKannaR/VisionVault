"""
make_receipt.py — generates the "DOM blind spot" asset for the evaluation.

Produces a receipt image whose personal data exists ONLY as pixels: there is no text node, no
input, no attribute anywhere in the DOM that contains it. The fixture displays it as a CSS
background-image, so the DOM scanner cannot see it and the media heuristic (which only covers
<img>/<video>/<canvas>) does not fire either. Recovering it requires OCR.

Alongside the PNG it writes receipt-boxes.json: the exact pixel box of each sensitive line, so
the fixture can place ground-truth markers over them without anyone hand-measuring.

Run:  python eval/assets/make_receipt.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
WIDTH, HEIGHT = 620, 260


def load_font(size, bold=False):
    candidates = [
        "C:/Windows/Fonts/consola.ttf" if not bold else "C:/Windows/Fonts/consolab.ttf",
        "C:/Windows/Fonts/arial.ttf" if not bold else "C:/Windows/Fonts/arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


# (prefix, sensitive_value, gt_type)
#
# The prefix is a plain field label and is NOT sensitive; only the value is. Ground truth is
# recorded for the value's box alone, so a detector that tightly masks "4539 8842 1176 3320"
# scores as a hit rather than being penalised for not also covering the word "Card:".
LINES = [
    ("PAYMENT RECEIPT", "", None),
    ("Order A-77120  -  14 Mar", "", None),
    ("", "", None),
    ("Billed to: ", "Priya Raghavan", "name"),
    ("Card: ", "4539 8842 1176 3320", "card"),
    ("Email: ", "priya.raghavan@examplemail.com", "email"),
    ("Phone: ", "+91 98450 31776", "phone"),
    ("", "", None),
    ("Thank you for your purchase.", "", None),
]


def main():
    img = Image.new("RGB", (WIDTH, HEIGHT), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, WIDTH - 1, HEIGHT - 1], outline=(190, 196, 208), width=2)

    title_font = load_font(22, bold=True)
    body_font = load_font(19)

    boxes = []
    y = 22
    for prefix, value, gt_type in LINES:
        line = prefix + value
        if not line:
            y += 14
            continue
        font = title_font if line == "PAYMENT RECEIPT" else body_font
        d.text((24, y), line, fill=(17, 24, 39), font=font)

        if value:
            # Box the VALUE only: start where the label prefix ends.
            value_x = 24 + int(d.textlength(prefix, font=font))
            bbox = d.textbbox((value_x, y), value, font=font)
            boxes.append({
                "type": gt_type,
                "x": max(0, bbox[0] - 3),
                "y": max(0, bbox[1] - 3),
                "w": (bbox[2] - bbox[0]) + 6,
                "h": (bbox[3] - bbox[1]) + 6,
                "text": value,
            })
        y += (font.size + 12)

    png_path = os.path.join(OUT_DIR, "receipt-card.png")
    img.save(png_path, "PNG", optimize=True)

    json_path = os.path.join(OUT_DIR, "receipt-boxes.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"width": WIDTH, "height": HEIGHT, "sensitiveLines": boxes}, f, indent=2)

    print("wrote", png_path, img.size, os.path.getsize(png_path), "bytes")
    print("wrote", json_path, f"({len(boxes)} sensitive lines)")
    for b in boxes:
        print(f"   {b['type']:6s} {b['x']},{b['y']} {b['w']}x{b['h']}  {b['text']}")


if __name__ == "__main__":
    main()
