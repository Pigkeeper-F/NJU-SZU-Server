"""Common helpers for figure2data: axis detection, calibration, tick labels."""
import cv2
import numpy as np
import fitz  # PyMuPDF
import io
from PIL import Image


def extract_figure_native(pdf_path, page_idx):
    """Concatenate all embedded images on a PDF page into one native-resolution
    figure PNG. Returns numpy RGB array. Works when figure is embedded as a
    horizontal-strip raster (common in Chinese journals). Inverts if needed."""
    doc = fitz.open(pdf_path)
    page = doc[page_idx]
    imgs = page.get_images(full=True)
    if not imgs:
        return None
    parts = []
    for img_info in imgs:
        xref = img_info[0]
        base = doc.extract_image(xref)
        pil = Image.open(io.BytesIO(base['image'])).convert('L')
        rects = page.get_image_rects(xref)
        y0 = rects[0].y0 if rects else 0
        parts.append((y0, np.array(pil)))
    parts.sort(key=lambda t: t[0])
    W = parts[0][1].shape[1]
    stitched = np.vstack([p[1] for p in parts])
    # Invert if majority-black (PDF stencil render)
    if stitched.mean() < 128:
        stitched = 255 - stitched
    return stitched


def threshold_bw(gray, thr=150):
    return ((gray < thr).astype(np.uint8)) * 255


def detect_plot_lines(bw, min_h_len=200, min_v_len=150):
    """Return (long_horizontals, long_verticals) as lists of (start,end,peak)."""
    kh = cv2.getStructuringElement(cv2.MORPH_RECT, (min_h_len, 1))
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kh)
    kv = cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_v_len))
    vert = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kv)
    hrow = horiz.sum(axis=1) / 255
    vcol = vert.sum(axis=0) / 255

    def grp(a, thr):
        idx = np.where(a > thr)[0]
        if len(idx) == 0: return []
        gs = [[idx[0]]]
        for i in idx[1:]:
            if i - gs[-1][-1] <= 3: gs[-1].append(i)
            else: gs.append([i])
        return [(int(g[0]), int(g[-1]), float(a[g[0]:g[-1]+1].max())) for g in gs]

    return grp(hrow, min_h_len * 0.5), grp(vcol, min_v_len * 0.5)


def detect_tick_label_cy(bw, axis_x, side='right', label_gap=3, label_width=38,
                         cluster_tol=6, digit_w=(4, 12), digit_h=(10, 20),
                         digit_area=(25, 150)):
    """Y-axis tick label centers. Tune digit_w/h/area for resolution."""
    if side == 'right':
        x0, x1 = axis_x + label_gap, axis_x + label_gap + label_width
    else:
        x0, x1 = max(0, axis_x - label_gap - label_width), axis_x - label_gap
    zone = bw[:, x0:x1]
    num, labels, stats, centroids = cv2.connectedComponentsWithStats(zone, connectivity=8)
    rows = []
    for i in range(1, num):
        x, y, w, h, area = stats[i]
        if (digit_w[0] <= w <= digit_w[1] and digit_h[0] <= h <= digit_h[1]
                and digit_area[0] <= area <= digit_area[1]):
            rows.append(int(centroids[i][1]))
    rows.sort()
    if not rows: return []
    clusters = [[rows[0]]]
    for r in rows[1:]:
        if r - clusters[-1][-1] <= cluster_tol:
            clusters[-1].append(r)
        else:
            clusters.append([r])
    return [int(np.mean(c)) for c in clusters]


def detect_x_ticks_upward(bw, B_axis, min_run=4, max_run=14):
    """X-axis tick mark positions (upward short runs from bottom axis)."""
    tick_like = []
    for x in range(bw.shape[1]):
        if bw[B_axis, x] == 0: continue
        c = 0
        for dy in range(1, 30):
            if B_axis - dy < 0: break
            if bw[B_axis - dy, x] > 0: c += 1
            else: break
        if min_run <= c <= max_run:
            tick_like.append(x)
    if not tick_like: return []
    gs = [[tick_like[0]]]
    for r in tick_like[1:]:
        if r - gs[-1][-1] <= 4: gs[-1].append(r)
        else: gs.append([r])
    return [int(np.mean(g)) for g in gs]


def linear_fit_axis(tick_pixels_cy, tick_values):
    """Fit value = a*y_pixel + b. tick_pixels top-to-bottom, values in any order."""
    ys = np.array(sorted(tick_pixels_cy))
    vs = np.array(sorted(tick_values, reverse=True))
    a, b = np.polyfit(ys, vs, 1)
    return float(a), float(b)
