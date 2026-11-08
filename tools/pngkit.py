import math, struct, sys, zlib


def shield(x, y):
    if y < 0.12 or y > 0.95:
        return False
    if y < 0.55:
        half = 0.38
    else:
        t = (y - 0.55) / 0.40
        half = 0.38 * math.sqrt(max(0.0, 1 - t * t))
    return abs(x - 0.5) <= half


def png(size, ctype, raw):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, ctype, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def output_dir():
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <output dir>")
    return sys.argv[1]
