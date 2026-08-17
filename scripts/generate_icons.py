"""
One-off generator for the PWA app icons — replaces the 1x1 placeholder
stubs in public/icons/ (see public/icons/NOTE.md) with real branded icons
matching the dashboard's existing identity: a violet-600 (#7c3aed) rounded
square with a white four-point sparkle, the same combination already used
for the header's logo mark (see App.tsx's `<Sparkles>` in a
`bg-violet-600` box).

Not part of the app's runtime or build — a dev-time tool, run once (and
again if the brand mark ever changes). Requires Pillow (already present
in this environment); not added to package.json since nothing in the
Node/npm toolchain depends on it.
"""

from PIL import Image, ImageDraw

VIOLET = (124, 58, 237, 255)  # Tailwind violet-600
WHITE = (255, 255, 255, 255)


def sparkle_polygon(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    """A 4-point sparkle/star (long axis-aligned points, short diagonal points), matching lucide's Sparkles glyph silhouette closely enough to read as the same mark at icon sizes."""
    inner = r * 0.28
    return [
        (cx, cy - r),
        (cx + inner, cy - inner),
        (cx + r, cy),
        (cx + inner, cy + inner),
        (cx, cy + r),
        (cx - inner, cy + inner),
        (cx - r, cy),
        (cx - inner, cy - inner),
    ]


def draw_icon(size: int, corner_radius_ratio: float, sparkle_ratio: float, edge_to_edge: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if edge_to_edge:
        # Maskable icons: OS clips to its own shape, so the background must
        # run to the canvas edge with no baked-in corner rounding — only
        # content inside the ~safe-zone circle is guaranteed visible.
        draw.rectangle([0, 0, size, size], fill=VIOLET)
    else:
        radius = size * corner_radius_ratio
        draw.rounded_rectangle([0, 0, size, size], radius=radius, fill=VIOLET)
    cx = cy = size / 2
    r = size * sparkle_ratio
    draw.polygon(sparkle_polygon(cx, cy, r), fill=WHITE)
    return img


def draw_badge(size: int) -> Image.Image:
    """Monochrome badge for notification tray icons — solid violet disc, no sparkle detail (badges render tiny and get tinted by the OS anyway)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([2, 2, size - 2, size - 2], fill=VIOLET)
    return img


OUT_DIR = "public/icons"

# Standard installability icons (Android/Chrome minimums are 192 and 512).
draw_icon(192, corner_radius_ratio=0.22, sparkle_ratio=0.32, edge_to_edge=False).save(f"{OUT_DIR}/appointment-192.png")
draw_icon(512, corner_radius_ratio=0.22, sparkle_ratio=0.32, edge_to_edge=False).save(f"{OUT_DIR}/appointment-512.png")

# Maskable variants — sparkle sized down further to stay inside every OS's safe-zone circle regardless of mask shape.
draw_icon(192, corner_radius_ratio=0, sparkle_ratio=0.24, edge_to_edge=True).save(f"{OUT_DIR}/maskable-192.png")
draw_icon(512, corner_radius_ratio=0, sparkle_ratio=0.24, edge_to_edge=True).save(f"{OUT_DIR}/maskable-512.png")

# iOS home-screen icon — apple-touch-icon convention, no transparency (iOS ignores alpha and would otherwise show black).
apple_icon = draw_icon(180, corner_radius_ratio=0.22, sparkle_ratio=0.32, edge_to_edge=False)
apple_flat = Image.new("RGB", apple_icon.size, VIOLET[:3])
apple_flat.paste(apple_icon, mask=apple_icon.split()[3])
apple_flat.save(f"{OUT_DIR}/apple-touch-icon.png")

# Notification badge (unchanged size/purpose from the existing placeholder).
draw_badge(72).save(f"{OUT_DIR}/badge-72.png")

print("Generated: appointment-192.png, appointment-512.png, maskable-192.png, maskable-512.png, apple-touch-icon.png, badge-72.png")
