import struct, zlib, math, sys, os

def shield(x, y):
    if y < 0.12 or y > 0.95: return False
    if y < 0.55:
        half = 0.38
    else:
        t = (y - 0.55) / 0.40
        half = 0.38 * math.sqrt(max(0.0, 1 - t * t))
    return abs(x - 0.5) <= half

def inner_mark(x, y):
    return abs(x - 0.5) < 0.065 and 0.28 < y < 0.75

def render(size):
    ss = 4
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            cov = mark = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if shield(x, y):
                        cov += 1
                        if inner_mark(x, y): mark += 1
            n = ss * ss
            a = cov / n
            m = mark / max(cov, 1)
            r = int(192 * (1 - m) + 255 * m)
            g = int(57 * (1 - m) + 255 * m)
            b = int(43 * (1 - m) + 255 * m)
            row += bytes([r, g, b, int(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

out = sys.argv[1]
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f"icon{s}.png"), "wb") as f:
        f.write(render(s))
