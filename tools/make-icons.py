import os
from pngkit import shield, png, output_dir

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
    return png(size, 6, raw)

out = output_dir()
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f"icon{s}.png"), "wb") as f:
        f.write(render(s))
