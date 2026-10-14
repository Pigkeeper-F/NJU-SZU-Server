"""Bar-chart extractor. Config-driven for per-subplot bar order + tick values."""
import cv2
import numpy as np
from pathlib import Path
from .core import threshold_bw, detect_plot_lines, detect_tick_label_cy, linear_fit_axis


def detect_plot_area_auto(bw, require_right_frame=True, min_h_len=None, min_v_len=None):
    """Pick bottom horizontal + left+right vertical frames from detected lines.
    Auto-scales line thresholds to image size."""
    H, W = bw.shape
    min_h_len = min_h_len or max(200, W // 4)
    min_v_len = min_v_len or max(150, H // 4)
    h_lines, v_lines = detect_plot_lines(bw, min_h_len=min_h_len, min_v_len=min_v_len)
    h_valid = [ln for ln in h_lines if ln[0] > 20]
    if not h_valid:
        raise RuntimeError('no bottom axis detected')
    B = max(h_valid, key=lambda ln: ln[2])[0]
    v_sorted = sorted(v_lines, key=lambda ln: -ln[2])[:4]
    if not v_sorted:
        raise RuntimeError('no vertical frames detected')
    xs = sorted(int((ln[0] + ln[1]) // 2) for ln in v_sorted)
    L, R = xs[0], xs[-1]
    return L, R, B


def extract_bars_from_subplot(img, bw, cfg):
    """cfg keys:
       - plot_area: {L,R,B}  (optional; auto-detect if missing)
       - y_axis_side: 'left' or 'right'
       - tick_values: [list]
       - bar_order: [treatment names]
       - y_unit: string (for CSV header)
       - label_width, label_gap, digit_w/h/area (optional tuning)
       - min_bar_width (default 25), min_wide_comp (default 30)
    """
    pa = cfg.get('plot_area') or {}
    if 'L' in pa:
        L, R, B = pa['L'], pa['R'], pa['B']
    else:
        L, R, B = detect_plot_area_auto(bw)

    side = cfg.get('y_axis_side', 'right')
    axis_x = R if side == 'right' else L
    tick_cys = detect_tick_label_cy(
        bw, axis_x, side=side,
        label_gap=cfg.get('label_gap', 3),
        label_width=cfg.get('label_width', 38),
        cluster_tol=cfg.get('cluster_tol', 6),
        digit_w=tuple(cfg.get('digit_w', (4, 12))),
        digit_h=tuple(cfg.get('digit_h', (10, 20))),
        digit_area=tuple(cfg.get('digit_area', (25, 150))),
    )
    if len(tick_cys) != len(cfg['tick_values']):
        raise RuntimeError(f"tick count mismatch: detected {len(tick_cys)}, "
                           f"expected {len(cfg['tick_values'])}")
    a, b = linear_fit_axis(tick_cys, cfg['tick_values'])

    min_wide_comp = cfg.get('min_wide_comp', 30)
    # min_bar_width defaults to 50% of bar width (auto-scales to resolution).
    # Filters error-bar T-caps which are typically <30% of bar width.
    min_bar_width_ratio = cfg.get('min_bar_width_ratio', 0.5)
    min_bar_width_explicit = cfg.get('min_bar_width')  # None or int

    plot_mask = np.zeros_like(bw)
    plot_mask[:B-1, L+1:R-1] = bw[:B-1, L+1:R-1]
    plot_mask[B-1:B+2, :] = 0
    plot_mask[:, L-1:L+2] = 0
    plot_mask[:, R-1:R+2] = 0

    num, labels, stats, centroids = cv2.connectedComponentsWithStats(plot_mask, connectivity=8)
    cands = []
    bar_touch_tol = cfg.get('bar_touch_tol', 5)  # bars must touch bottom axis
    for i in range(1, num):
        x, y, w, h, area = stats[i]
        # require bar to reach bottom axis (excludes panel titles, stray text)
        if w >= min_wide_comp and h >= 15 and (y + h) >= (B - bar_touch_tol):
            cands.append({'idx': i, 'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h),
                          'cx': float(centroids[i][0])})
    cands.sort(key=lambda d: d['cx'])

    bars = []
    for c in cands[:len(cfg['bar_order'])]:
        comp_mask = (labels == c['idx']).astype(np.uint8)
        sub = comp_mask[:, c['x']:c['x']+c['w']]
        row_widths = sub.sum(axis=1)
        min_bar_width = (min_bar_width_explicit if min_bar_width_explicit is not None
                          else int(c['w'] * min_bar_width_ratio))
        wide_rows = np.where(row_widths >= min_bar_width)[0]
        top_y = int(wide_rows.min()) if len(wide_rows) else int(np.where(row_widths >= 5)[0].min())
        ys_all, _ = np.where(comp_mask > 0)
        errbar_top_y = int(ys_all.min())
        value = a * top_y + b
        errbar_val = a * errbar_top_y + b
        bars.append({
            'treatment': cfg['bar_order'][len(bars)],
            'x_center': c['cx'],
            'bar_top_y': top_y,
            'value': round(float(value), 2),
            'errbar_top_y': errbar_top_y,
            'errbar_top_value': round(float(errbar_val), 2),
            'error': round(float(errbar_val - value), 2),
        })

    return {
        'bars': bars,
        'calibration': {'a': a, 'b': b, 'tick_cys': tick_cys, 'tick_values': cfg['tick_values']},
        'plot_area': {'L': L, 'R': R, 'B': B},
        'y_axis_side': side,
    }


def write_bar_csv_and_overlay(img, result, cfg, out_csv, out_vis):
    bars = result['bars']
    L, R, B = result['plot_area']['L'], result['plot_area']['R'], result['plot_area']['B']
    tick_cys = result['calibration']['tick_cys']
    tick_vals = result['calibration']['tick_values']
    axis_x = R if result['y_axis_side'] == 'right' else L

    Path(out_csv).parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, 'w', encoding='utf-8') as f:
        f.write(f'treatment,bar_top_y_px,value_{cfg.get("y_unit","")},errbar_top_value,error\n')
        for r in bars:
            f.write(f"{r['treatment']},{r['bar_top_y']},{r['value']},"
                    f"{r['errbar_top_value']},{r['error']}\n")

    vis = img.copy()
    H, W = vis.shape[:2]
    cv2.line(vis, (0, B), (W, B), (255, 0, 0), 1)
    cv2.line(vis, (L, 0), (L, H), (255, 0, 0), 1)
    cv2.line(vis, (R, 0), (R, H), (255, 0, 0), 1)
    for cy, tv in zip(tick_cys, sorted(tick_vals, reverse=True)):
        dx = 5 if result['y_axis_side'] == 'right' else -5
        cv2.line(vis, (axis_x, cy), (axis_x + dx, cy), (180, 180, 0), 1)
    for r in bars:
        cx = int(r['x_center']); ty = r['bar_top_y']; ey = r['errbar_top_y']
        cv2.circle(vis, (cx, ty), 5, (0, 0, 255), -1)
        cv2.circle(vis, (cx, ey), 3, (0, 180, 0), -1)
        cv2.line(vis, (cx, ty), (cx, ey), (0, 180, 0), 1)
        cv2.putText(vis, f"{r['treatment']}={r['value']:.0f}+-{r['error']:.0f}",
                    (cx - 55, ty - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out_vis), vis)


def run_bar_subplot(subplot_img_path, cfg, out_csv, out_vis):
    img = cv2.imread(str(subplot_img_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bw = threshold_bw(gray)
    result = extract_bars_from_subplot(img, bw, cfg)
    write_bar_csv_and_overlay(img, result, cfg, out_csv, out_vis)
    return result
