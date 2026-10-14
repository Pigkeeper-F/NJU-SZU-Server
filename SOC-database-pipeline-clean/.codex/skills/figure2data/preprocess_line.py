"""Line-chart preprocessing: auto-calibrate axes, detect ticks, emit meta JSON
for Codex to use when visually reading series values from the figure."""
import cv2
import json
import numpy as np
from pathlib import Path
from .core import threshold_bw, detect_tick_label_cy, detect_x_ticks_upward, linear_fit_axis


def preprocess_line_subplot(subplot_img_path, cfg, out_meta_json):
    """cfg keys:
       - plot_area: optional {L,B}; auto-detect if missing (need L + B for line plots)
       - y_axis_side: 'left' or 'right'
       - y_tick_values: list (e.g. [0,50,100,...,250])
       - dates / x_labels: list of strings
       - label_width/digit_* optional tuning
       - min_tick_run/max_tick_run optional for x-tick detection
    """
    img = cv2.imread(str(subplot_img_path))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bw = threshold_bw(gray)

    pa = cfg.get('plot_area') or {}
    L = pa.get('L')
    B = pa.get('B')
    if L is None or B is None:
        from .core import detect_plot_lines
        h_lines, v_lines = detect_plot_lines(bw, min_h_len=200, min_v_len=200)
        if h_lines:
            B = max([ln for ln in h_lines if ln[0] > 20], key=lambda ln: ln[2])[0]
        if v_lines:
            L = min(v_lines, key=lambda ln: ln[0])[0]

    side = cfg.get('y_axis_side', 'left')
    axis_x = L if side == 'left' else pa.get('R')
    cys = detect_tick_label_cy(
        bw, axis_x, side=side,
        label_gap=cfg.get('label_gap', 3),
        label_width=cfg.get('label_width', 40),
        cluster_tol=cfg.get('cluster_tol', 6),
        digit_w=tuple(cfg.get('digit_w', (4, 30))),
        digit_h=tuple(cfg.get('digit_h', (10, 50))),
        digit_area=tuple(cfg.get('digit_area', (25, 600))),
    )
    if len(cys) != len(cfg['y_tick_values']):
        raise RuntimeError(f"y-tick mismatch: detected {len(cys)}, expected {len(cfg['y_tick_values'])}")
    a_y, b_y = linear_fit_axis(cys, cfg['y_tick_values'])

    x_ticks = detect_x_ticks_upward(
        bw, B,
        min_run=cfg.get('min_tick_run', 4),
        max_run=cfg.get('max_tick_run', 14),
    )[:len(cfg['dates'])]

    meta = {
        'subplot_image': str(subplot_img_path),
        'plot_area': {'L': L, 'B': B},
        'y_axis_side': side,
        'y_tick_values': cfg['y_tick_values'],
        'y_tick_cys': cys,
        'a_y': a_y, 'b_y': b_y,
        'dates': cfg['dates'],
        'x_ticks': x_ticks,
        'series_order': cfg['series_order'],
    }
    Path(out_meta_json).parent.mkdir(parents=True, exist_ok=True)
    with open(out_meta_json, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta


def finalize_line(meta_json, readings_json, out_csv, out_vis, series_color=None):
    """Readings JSON shape:
       {"T1": {"CK": 65, "N0": 32, ...}, "T2": {...}, ...}
    Values are y-axis numeric values read visually by Codex."""
    with open(meta_json, encoding='utf-8') as f:
        meta = json.load(f)
    with open(readings_json, encoding='utf-8') as f:
        readings = json.load(f)

    dates = meta['dates']
    series_order = meta['series_order']
    Path(out_csv).parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, 'w', encoding='utf-8') as f:
        f.write('series,' + ','.join(dates) + '\n')
        for name in series_order:
            cells = []
            for ti, d in enumerate(dates):
                v = readings.get(f'T{ti+1}', {}).get(name)
                cells.append(str(v) if v is not None else '')
            f.write(f'{name},' + ','.join(cells) + '\n')

    img = cv2.imread(meta['subplot_image'])
    vis = img.copy()
    L, B = meta['plot_area']['L'], meta['plot_area']['B']
    cv2.line(vis, (0, B), (vis.shape[1], B), (255, 0, 0), 1)
    cv2.line(vis, (L, 0), (L, vis.shape[0]), (255, 0, 0), 1)
    a_y, b_y = meta['a_y'], meta['b_y']
    default_colors = {'CK':(0,0,255),'N0':(255,128,0),'RFF':(0,200,0),
                      'HACF':(200,0,200),'PACF':(0,200,200),
                      'FACF':(128,0,128),'SMF':(0,128,128)}
    colors = series_color or default_colors

    for ti, xt in enumerate(meta['x_ticks']):
        cv2.line(vis, (xt, B-6), (xt, B+6), (180, 180, 0), 2)
        tvals = readings.get(f'T{ti+1}', {})
        for name, v in tvals.items():
            if v is None: continue
            y_px = int((v - b_y) / a_y)
            clr = colors.get(name, (0, 0, 0))
            cv2.circle(vis, (xt, y_px), 12, clr, 2)
            cv2.putText(vis, f'{name}={v}', (xt+13, y_px+4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, clr, 1)
    cv2.imwrite(str(out_vis), vis)
    return {'meta': meta, 'readings': readings}
