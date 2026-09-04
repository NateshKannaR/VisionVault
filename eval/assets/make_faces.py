"""
make_faces.py — generates the synthetic portrait images used by the evaluation fixtures.

Why synthetic: the evaluation must run fully offline and be byte-for-byte reproducible, so the
fixtures cannot pull avatars from a CDN. These are shaded, photo-like renderings (soft skin
gradient, eye sockets, brows, nose and mouth shadows, blurred edges) rather than flat cartoons,
because UltraFace RFB-320 keys on that shading structure.

Whether UltraFace actually fires on them is measured, not assumed — eval/run-full-eval.js
reports the real per-source detection counts, and eval_report.md states plainly that face
recall is measured against synthetic portraits, not photographs of people.

Run:  python eval/assets/make_faces.py
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

VARIANTS = [
    # (filename, skin, hair, background, seed)
    ("face-1.png", (222, 184, 152), (58, 42, 34), (206, 214, 226), 11),
    ("face-2.png", (196, 150, 118), (30, 26, 24), (214, 208, 200), 23),
    ("face-3.png", (238, 206, 180), (120, 82, 48), (198, 210, 204), 37),
    ("face-4.png", (168, 124, 96), (24, 20, 20), (220, 216, 226), 51),
]

SIZE = 320


def shade(color, factor):
    return tuple(max(0, min(255, int(c * factor))) for c in color)


def render_face(skin, hair, bg, seed):
    rnd = random.Random(seed)
    img = Image.new("RGB", (SIZE, SIZE), bg)
    d = ImageDraw.Draw(img)

    cx, cy = SIZE // 2, int(SIZE * 0.52)
    fw, fh = int(SIZE * 0.46), int(SIZE * 0.60)

    # Neck and shoulders
    d.rounded_rectangle(
        [cx - fw // 3, cy + fh // 3, cx + fw // 3, SIZE], radius=24, fill=shade(skin, 0.88)
    )
    d.ellipse([cx - int(SIZE * 0.46), int(SIZE * 0.88), cx + int(SIZE * 0.46), SIZE + 60],
              fill=shade(bg, 0.72))

    # Hair mass behind the head
    d.ellipse([cx - fw - 10, cy - fh - 6, cx + fw + 10, cy + fh // 3], fill=hair)

    # Face oval with a vertical light gradient
    face = Image.new("RGB", (SIZE, SIZE), bg)
    fd = ImageDraw.Draw(face)
    for i in range(fh * 2):
        t = i / float(fh * 2)
        factor = 1.06 - 0.30 * t
        y = cy - fh + i
        fd.line([(0, y), (SIZE, y)], fill=shade(skin, factor))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse([cx - fw, cy - fh, cx + fw, cy + fh], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(2))
    img.paste(face, (0, 0), mask)
    d = ImageDraw.Draw(img)

    eye_y = cy - int(fh * 0.16)
    eye_dx = int(fw * 0.42)
    eye_w = int(fw * 0.30)
    eye_h = int(fh * 0.13)

    for sign in (-1, 1):
        ex = cx + sign * eye_dx
        # socket shadow
        d.ellipse([ex - eye_w, eye_y - eye_h, ex + eye_w, eye_y + eye_h], fill=shade(skin, 0.80))
        # sclera
        d.ellipse([ex - int(eye_w * 0.78), eye_y - int(eye_h * 0.62),
                   ex + int(eye_w * 0.78), eye_y + int(eye_h * 0.62)], fill=(246, 244, 240))
        # iris + pupil
        ir = int(eye_h * 0.58)
        d.ellipse([ex - ir, eye_y - ir, ex + ir, eye_y + ir], fill=(72, 92, 108))
        d.ellipse([ex - ir // 2, eye_y - ir // 2, ex + ir // 2, eye_y + ir // 2], fill=(18, 16, 18))
        d.ellipse([ex - ir // 2 - 1, eye_y - ir, ex - ir // 6, eye_y - ir // 3], fill=(238, 238, 238))
        # brow
        d.line([(ex - eye_w, eye_y - int(eye_h * 1.7)), (ex + eye_w, eye_y - int(eye_h * 2.0))],
               fill=shade(hair, 0.9), width=max(3, fh // 34))

    # Nose: bridge highlight + nostril shadow
    nose_y = cy + int(fh * 0.12)
    d.line([(cx, eye_y + eye_h), (cx - int(fw * 0.09), nose_y)], fill=shade(skin, 0.86),
           width=max(2, fw // 30))
    d.ellipse([cx - int(fw * 0.17), nose_y - int(fh * 0.03),
               cx + int(fw * 0.17), nose_y + int(fh * 0.07)], fill=shade(skin, 0.83))

    # Mouth
    mouth_y = cy + int(fh * 0.38)
    d.ellipse([cx - int(fw * 0.34), mouth_y - int(fh * 0.07),
               cx + int(fw * 0.34), mouth_y + int(fh * 0.09)], fill=shade((172, 96, 92), 1.0))
    d.line([(cx - int(fw * 0.34), mouth_y + 1), (cx + int(fw * 0.34), mouth_y + 1)],
           fill=shade((120, 62, 60), 1.0), width=2)

    # Cheek/jaw shading
    for sign in (-1, 1):
        d.ellipse([cx + sign * int(fw * 0.62) - 18, cy + int(fh * 0.10),
                   cx + sign * int(fw * 0.62) + 18, cy + int(fh * 0.40)],
                  fill=shade(skin, 0.90))

    # Hair fringe over the forehead
    d.pieslice([cx - fw - 8, cy - fh - 10, cx + fw + 8, cy + int(fh * 0.10)],
               start=185, end=355, fill=hair)

    img = img.filter(ImageFilter.GaussianBlur(0.9))

    # Light film grain so the image is not perfectly flat
    px = img.load()
    for _ in range(SIZE * SIZE // 6):
        x, y = rnd.randrange(SIZE), rnd.randrange(SIZE)
        r, g, b = px[x, y]
        n = rnd.randint(-9, 9)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))

    return img


def main():
    for name, skin, hair, bg, seed in VARIANTS:
        img = render_face(skin, hair, bg, seed)
        path = os.path.join(OUT_DIR, name)
        img.save(path, "PNG", optimize=True)
        print("wrote", path, img.size, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    main()
