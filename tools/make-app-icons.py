import math, os, struct, sys, zlib

BG = (24, 25, 29)
RED = (192, 57, 43)
WHITE = (255, 255, 255)


def shield(x, y):
    if y < 0.12 or y > 0.95:
        return False
    if y < 0.55:
        half = 0.38
    else:
        t = (y - 0.55) / 0.40
        half = 0.38 * math.sqrt(max(0.0, 1 - t * t))
    return abs(x - 0.5) <= half


def bar(x, y):
    return abs(x - 0.5) < 0.065 and 0.28 < y < 0.75


def in_squircle(x, y, inset, radius):
    lo, hi = inset, 1 - inset
    if x < lo or x > hi or y < lo or y > hi:
        return False
    cx = min(max(x, lo + radius), hi - radius)
    cy = min(max(y, lo + radius), hi - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def sample(x, y, mac):
    if mac and not in_squircle(x, y, 0.0977, 0.18):
        return None
    scale = 0.62 if mac else 0.7
    sx = (x - 0.5) / scale + 0.5
    sy = (y - 0.5) / scale + 0.5 + 0.02
    if shield(sx, sy):
        return WHITE if bar(sx, sy) else RED
    return BG


def render(size, mac, ss):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, mac)
                    if c is None:
                        continue
                    r += c[0]; g += c[1]; b += c[2]; a += 1
            n = ss * ss
            if mac:
                row += bytes([r // a if a else 0, g // a if a else 0, b // a if a else 0, a * 255 // n])
            else:
                row += bytes([r // n, g // n, b // n])
        rows.append(bytes(row))
    raw = b"".join(rows)
    ctype = 6 if mac else 2

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, ctype, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


out = sys.argv[1]
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "universal-icon-1024@1x.png"), "wb") as f:
    f.write(render(1024, False, 2))
for base in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        size = base * scale
        with open(os.path.join(out, f"mac-icon-{base}@{scale}x.png"), "wb") as f:
            f.write(render(size, True, 2 if size >= 512 else 4))
