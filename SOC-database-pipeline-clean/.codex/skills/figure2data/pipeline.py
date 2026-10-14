"""figure2data pipeline: PDF → figure localization → subplot extraction → CSV.

Usage:
  python -m .codex.skills.figure2data.pipeline extract_figure --config CONFIG.json
  python -m .codex.skills.figure2data.pipeline bar --subplot IMG.png --config sub.json --out-dir OUT
  python -m .codex.skills.figure2data.pipeline line_pre --subplot IMG.png --config sub.json --out-meta META.json
  python -m .codex.skills.figure2data.pipeline line_final --meta META.json --readings R.json --out-dir OUT
"""
import argparse
import json
import sys
import cv2
import numpy as np
from pathlib import Path

if __package__ is None or __package__ == '':
    # Allow direct script invocation
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from figure2data.core import extract_figure_native, threshold_bw
    from figure2data.extract_bar import run_bar_subplot
    from figure2data.preprocess_line import preprocess_line_subplot, finalize_line
else:
    from .core import extract_figure_native, threshold_bw
    from .extract_bar import run_bar_subplot
    from .preprocess_line import preprocess_line_subplot, finalize_line


def cmd_extract_figure(args):
    """Locate & extract target figure from PDF at native resolution, write subplots.
    Config JSON shape:
      {
        "pdf_path": "...",
        "page_idx": 4,
        "fig_output": "fig2_native.png",
        "subplots": {
          "A_bar": {"crop": [680, 560, 1680, 1050]},
          ...
        }
      }
    """
    cfg = json.loads(Path(args.config).read_text(encoding='utf-8'))
    native = extract_figure_native(cfg['pdf_path'], cfg['page_idx'])
    if native is None:
        raise RuntimeError('no embedded images found on page')
    out_dir = Path(args.out_dir) if args.out_dir else Path(cfg['pdf_path']).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    fig_out = out_dir / cfg.get('fig_output', 'figure_native.png')
    cv2.imwrite(str(fig_out), native)
    print(f'wrote figure: {fig_out} ({native.shape[1]}x{native.shape[0]})')

    for name, sub_cfg in cfg.get('subplots', {}).items():
        x0, y0, x1, y1 = sub_cfg['crop']
        sub_img = native[y0:y1, x0:x1]
        sub_out = out_dir / f'{name}.png'
        cv2.imwrite(str(sub_out), sub_img)
        print(f'  subplot {name}: {sub_out}')


def cmd_bar(args):
    cfg = json.loads(Path(args.config).read_text(encoding='utf-8'))
    out_dir = Path(args.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    name = Path(args.subplot).stem
    out_csv = out_dir / f'{name}.csv'
    out_vis = out_dir / f'{name}_verify.png'
    result = run_bar_subplot(args.subplot, cfg, out_csv, out_vis)
    print(f'extracted {len(result["bars"])} bars, wrote {out_csv.name}  {out_vis.name}')
    for r in result['bars']:
        print(f"  {r['treatment']:6}  {r['value']:8.2f}  ±{r['error']}")


def cmd_line_pre(args):
    cfg = json.loads(Path(args.config).read_text(encoding='utf-8'))
    meta = preprocess_line_subplot(args.subplot, cfg, args.out_meta)
    print(f'wrote meta: {args.out_meta}')
    print(f'  y calib: value = {meta["a_y"]:.4f}*y + {meta["b_y"]:.4f}')
    print(f'  x-ticks: {meta["x_ticks"]}')
    print(f'  Next: Codex must visually read {args.subplot} and emit readings JSON '
          f'mapping T1..T{len(meta["x_ticks"])} → {{series: value}}.')


def cmd_line_final(args):
    out_dir = Path(args.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    name = Path(args.meta).stem.replace('_meta', '')
    out_csv = out_dir / f'{name}.csv'
    out_vis = out_dir / f'{name}_verify.png'
    result = finalize_line(args.meta, args.readings, out_csv, out_vis)
    print(f'wrote {out_csv.name}  {out_vis.name}')


def main(argv=None):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)

    p1 = sub.add_parser('extract_figure')
    p1.add_argument('--config', required=True)
    p1.add_argument('--out-dir', default=None)
    p1.set_defaults(func=cmd_extract_figure)

    p2 = sub.add_parser('bar')
    p2.add_argument('--subplot', required=True)
    p2.add_argument('--config', required=True)
    p2.add_argument('--out-dir', required=True)
    p2.set_defaults(func=cmd_bar)

    p3 = sub.add_parser('line_pre')
    p3.add_argument('--subplot', required=True)
    p3.add_argument('--config', required=True)
    p3.add_argument('--out-meta', required=True)
    p3.set_defaults(func=cmd_line_pre)

    p4 = sub.add_parser('line_final')
    p4.add_argument('--meta', required=True)
    p4.add_argument('--readings', required=True)
    p4.add_argument('--out-dir', required=True)
    p4.set_defaults(func=cmd_line_final)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    main()
