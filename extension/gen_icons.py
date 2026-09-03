#!/usr/bin/env python3
"""Generate PNG icons from icon.svg. Run once: python gen_icons.py"""
import sys
from pathlib import Path

base_dir = Path(__file__).resolve().parent
sizes = [16, 32, 48, 128]
svg_path = base_dir / "icon.svg"

try:
    import cairosvg
    for s in sizes:
        output_path = base_dir / f"icon{s}.png"
        cairosvg.svg2png(url=str(svg_path), write_to=str(output_path), output_width=s, output_height=s)
        print(f"✓ {output_path.name}")
except ImportError:
    try:
        from PIL import Image
        # Fallback: create simple colored squares
        for s in sizes:
            output_path = base_dir / f"icon{s}.png"
            img = Image.new("RGBA", (s, s), (108, 99, 255, 255))
            img.save(output_path)
            print(f"✓ {output_path.name} (placeholder — install cairosvg for real SVG render)")
    except ImportError:
        print("Install cairosvg: pip install cairosvg")
        print("Or Pillow: pip install Pillow")
        sys.exit(1)
