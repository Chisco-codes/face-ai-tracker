#!/usr/bin/env python3
"""
generate_icons.py
Run this once to create all PWA icon sizes.
Requires: pip install Pillow

Usage: python generate_icons.py
"""

import os
from PIL import Image, ImageDraw, ImageFont

sizes = [72, 96, 128, 144, 152, 192, 384, 512]

os.makedirs('icons', exist_ok=True)
os.makedirs('screenshots', exist_ok=True)

for size in sizes:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle — dark theme matching the app
    margin = size // 8
    draw.ellipse([margin, margin, size - margin, size - margin],
                 fill=(10, 12, 18, 255))

    # Cyan accent ring
    ring_w = max(2, size // 24)
    draw.ellipse([margin, margin, size - margin, size - margin],
                 outline=(0, 229, 255, 255), width=ring_w)

    # Simple face icon — two eye circles + smile arc
    cx, cy = size // 2, size // 2
    r = size // 5

    # Eye left
    ex1 = cx - r // 2
    ey  = cy - r // 4
    er  = max(2, size // 20)
    draw.ellipse([ex1 - er, ey - er, ex1 + er, ey + er], fill=(0, 229, 255, 255))

    # Eye right
    ex2 = cx + r // 2
    draw.ellipse([ex2 - er, ey - er, ex2 + er, ey + er], fill=(0, 229, 255, 255))

    # Smile
    smile_box = [cx - r // 2, cy, cx + r // 2, cy + r // 2]
    draw.arc(smile_box, start=0, end=180, fill=(0, 229, 255, 255),
             width=max(2, size // 28))

    img.save(f'icons/icon-{size}.png')
    print(f'Created icons/icon-{size}.png')

print('\nAll icons created!')
print('Now create screenshots/ folder manually or take screenshots of your app.')
print('Name them: screenshots/desktop.png and screenshots/mobile.png')