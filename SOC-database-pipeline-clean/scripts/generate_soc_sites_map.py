import base64
import json
import math
import re
import statistics
from pathlib import Path
from urllib.request import Request, urlopen

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PatchCollection
from matplotlib.font_manager import FontProperties
from matplotlib.patches import Polygon
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "results"
OUT_DIR.mkdir(exist_ok=True)

VIZ_DIR = Path(
    r"C:\Users\31307\.codex\visualizations\2026\07\25\019f987d-ff6f-7ed1-a79d-79fe3948fe27"
)
VIZ_DIR.mkdir(parents=True, exist_ok=True)

GEO_PATH = OUT_DIR / "china_provinces_datav_100000_full.json"

LON_KEY = "\u70b9\u4f4d\u4fe1\u606f.\u7ecf\u5ea6"
LAT_KEY = "\u70b9\u4f4d\u4fe1\u606f.\u7eac\u5ea6"
REGION_KEY = "\u70b9\u4f4d\u4fe1\u606f.Region"

ZONE_MIDDLE_LOWER_YANGTZE = "\u957f\u6c5f\u4e2d\u4e0b\u6e38\u533a"
ZONE_NORTHEAST = "\u4e1c\u5317\u533a"
ZONE_NORTH_CHINA_PLAIN = "\u534e\u5317\u5e73\u539f\u533a"
ZONE_NORTHWEST = "\u897f\u5317\u533a"
ZONE_SOUTHWEST = "\u897f\u5357\u533a"
ZONE_SOUTH_CHINA = "\u534e\u5357\u533a"
ZONE_TOTAL = "\u5408\u8ba1"
ZONE_ORDER = [
    ZONE_MIDDLE_LOWER_YANGTZE,
    ZONE_NORTHEAST,
    ZONE_NORTH_CHINA_PLAIN,
    ZONE_NORTHWEST,
    ZONE_SOUTHWEST,
    ZONE_SOUTH_CHINA,
]

NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def parse_num(value):
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if math.isfinite(value) else None
    match = NUM_RE.search(str(value).strip().replace(",", ""))
    if not match:
        return None
    number = float(match.group(0))
    return number if math.isfinite(number) else None


def get_soc(row):
    direct_keys = [
        "\u571f\u58e4\u4fe1\u606f.SOC (g/kg)",
        "SOC",
        "SOC (g/kg)",
        "SOC(g/kg)",
        "soil organic carbon",
    ]
    for key in direct_keys:
        if key in row:
            value = parse_num(row.get(key))
            if value is not None and 0 < value < 300:
                return value

    for key, raw_value in row.items():
        key_upper = str(key).upper()
        if "SOC" not in key_upper:
            continue
        if any(bad in key_upper for bad in ["POC", "MAOC", "DOC", "MBC", "STOCK", "DENSITY"]):
            continue
        if any(skip in str(key) for skip in ["\u5355\u4f4d", "\u5907\u6ce8", "\u571f\u5c42"]):
            continue
        value = parse_num(raw_value)
        if value is not None and 0 < value < 300:
            return value
    return None


def assign_zone(lon, lat, region):
    region_lower = (region or "").lower()
    if any(x in region_lower for x in ["northeast", "heilongjiang", "jilin", "liaoning"]):
        return ZONE_NORTHEAST
    if any(x in region_lower for x in ["northwest", "loess", "xinjiang", "gansu", "ningxia", "qinghai", "shaanxi"]):
        return ZONE_NORTHWEST
    if any(x in region_lower for x in ["southwest", "sichuan", "yunnan", "guizhou", "chongqing"]):
        return ZONE_SOUTHWEST
    if any(x in region_lower for x in ["south china", "guangdong", "guangxi", "hainan", "fujian"]):
        return ZONE_SOUTH_CHINA
    if any(x in region_lower for x in ["north china plain", "hebei", "henan", "shandong", "shanxi", "beijing", "tianjin"]):
        return ZONE_NORTH_CHINA_PLAIN
    if any(x in region_lower for x in ["middle", "lower yangtze", "jiangsu", "anhui", "hubei", "hunan", "jiangxi", "zhejiang", "shanghai"]):
        return ZONE_MIDDLE_LOWER_YANGTZE

    if lat >= 40 and lon >= 118:
        return ZONE_NORTHEAST
    if lon < 107 and lat >= 32:
        return ZONE_NORTHWEST
    if lat < 32 and lon < 108.5:
        return ZONE_SOUTHWEST
    if lat < 25 and lon >= 108:
        return ZONE_SOUTH_CHINA
    if 34 <= lat < 41 and 108 <= lon < 123:
        return ZONE_NORTH_CHINA_PLAIN
    if 25 <= lat < 34 and lon >= 108:
        return ZONE_MIDDLE_LOWER_YANGTZE
    if lon < 107:
        return ZONE_NORTHWEST
    if lat >= 40:
        return ZONE_NORTHEAST
    if lat < 25:
        return ZONE_SOUTH_CHINA
    if lat >= 34:
        return ZONE_NORTH_CHINA_PLAIN
    return ZONE_MIDDLE_LOWER_YANGTZE


def load_sites():
    sites = {}
    files_read = 0
    rows_seen = 0
    rows_with_coords_soc = 0
    for path in sorted((ROOT / "outputs").glob("*.json"), key=lambda p: int(p.stem) if p.stem.isdigit() else 10**9):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        files_read += 1
        if data.get("status") == "skipped":
            continue
        for row in data.get("rows") or []:
            if not isinstance(row, dict):
                continue
            rows_seen += 1
            lon = parse_num(row.get(LON_KEY))
            lat = parse_num(row.get(LAT_KEY))
            soc = get_soc(row)
            if lon is None or lat is None or soc is None:
                continue
            if not (73 <= lon <= 136 and 18 <= lat <= 54):
                continue
            rows_with_coords_soc += 1
            key = (round(lon, 5), round(lat, 5))
            rec = sites.setdefault(key, {"lon": round(lon, 5), "lat": round(lat, 5), "socs": [], "regions": []})
            rec["socs"].append(soc)
            if row.get(REGION_KEY):
                rec["regions"].append(str(row.get(REGION_KEY)))

    records = []
    for rec in sites.values():
        region = rec["regions"][0] if rec["regions"] else ""
        records.append(
            {
                "lon": rec["lon"],
                "lat": rec["lat"],
                "soc": statistics.median(rec["socs"]),
                "zone": assign_zone(rec["lon"], rec["lat"], region),
            }
        )
    return records, files_read, rows_seen, rows_with_coords_soc


def load_geojson():
    if not GEO_PATH.exists() or GEO_PATH.stat().st_size < 1000:
        request = Request(
            "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urlopen(request, timeout=30) as response:
            GEO_PATH.write_bytes(response.read())
    return json.loads(GEO_PATH.read_text(encoding="utf-8"))


def add_geom_patches(geom, patches):
    geom_type = geom.get("type")
    coords = geom.get("coordinates")
    if geom_type == "Polygon":
        for ring in coords[:1]:
            patches.append(Polygon(ring, closed=True))
    elif geom_type == "MultiPolygon":
        for poly in coords:
            for ring in poly[:1]:
                patches.append(Polygon(ring, closed=True))


def font_props():
    font_path = Path(r"C:\Windows\Fonts\msyh.ttc")
    if not font_path.exists():
        return None, None
    return FontProperties(fname=str(font_path)), FontProperties(fname=str(font_path), weight="bold")


def build_figure(records, geo):
    zone_counts = {zone: 0 for zone in ZONE_ORDER}
    for record in records:
        zone_counts[record["zone"]] = zone_counts.get(record["zone"], 0) + 1

    patches = []
    for feature in geo.get("features", []):
        add_geom_patches(feature.get("geometry") or {}, patches)

    cn_font, bold_font = font_props()
    fig = plt.figure(figsize=(16, 9), dpi=220, facecolor="white")

    paragraph = (
        f"\u6570\u636e\u5e93\u76ee\u524d\u5305\u542b {len(records)} \u4e2a\u552f\u4e00\u7ecf\u7eac\u5ea6 SOC "
        "\u89c2\u6d4b\u70b9\uff0c\u8986\u76d6\u6211\u56fd\u4e3b\u8981\u519c\u4e1a\u533a\u3002"
        "\u70b9\u4f4d\u4e3b\u8981\u96c6\u4e2d\u5728\u957f\u6c5f\u4e2d\u4e0b\u6e38\u533a\u3001"
        "\u4e1c\u5317\u533a\u3001\u534e\u5317\u5e73\u539f\u533a\u548c\u897f\u5317\u533a\uff1b"
        "\u897f\u5357\u533a\u548c\u534e\u5357\u533a\u5df2\u6709\u4e00\u5b9a\u8986\u76d6\uff0c"
        "\u6837\u70b9\u76f8\u5bf9\u8f83\u5c11\u3002"
    )
    fig.text(0.08, 0.905, paragraph, fontsize=13, color="#222222", fontproperties=cn_font, va="top")

    ax = fig.add_axes([0.08, 0.16, 0.54, 0.64])
    collection = PatchCollection(patches, facecolor="#f7f8f4", edgecolor="#c7d1c8", linewidth=0.5, zorder=1)
    ax.add_collection(collection)
    scatter = ax.scatter(
        [r["lon"] for r in records],
        [r["lat"] for r in records],
        c=[max(4, min(35, r["soc"])) for r in records],
        cmap="YlOrBr",
        s=13,
        alpha=0.86,
        linewidths=0,
        zorder=3,
        vmin=4,
        vmax=35,
    )

    ax.set_xlim(73, 135)
    ax.set_ylim(18, 54)
    ax.set_aspect("equal", adjustable="box")
    ax.set_title("Spatial distribution of SOC observation sites in China", loc="left", fontsize=15, weight="bold", pad=10)
    ax.set_xlabel("Longitude (deg E)", fontsize=10)
    ax.set_ylabel("Latitude (deg N)", fontsize=10)
    ax.grid(True, color="#d7ddd9", linewidth=0.55, alpha=0.65, zorder=0)
    for spine in ax.spines.values():
        spine.set_color("#8aa09a")
        spine.set_linewidth(0.8)
    ax.text(
        73.5,
        53.1,
        f"Unique lon-lat sites: {len(records)}",
        fontsize=9.5,
        bbox=dict(boxstyle="round,pad=0.25", facecolor="white", edgecolor="#c5ccd0", alpha=0.94),
        zorder=4,
    )
    for text, x, y in [
        ("Northeast", 124.5, 45.0),
        ("Northwest", 100.5, 36.2),
        ("North China Plain", 112.0, 36.0),
        ("Middle-Lower Yangtze", 111.0, 30.3),
        ("Southwest", 101.0, 25.2),
        ("South China", 109.7, 23.0),
    ]:
        ax.text(x, y, text, fontsize=8.5, color="#5d6664", zorder=4)

    cax = fig.add_axes([0.635, 0.245, 0.014, 0.53])
    colorbar = fig.colorbar(scatter, cax=cax)
    colorbar.set_label("SOC content (g kg$^{-1}$)", fontsize=10)
    colorbar.ax.tick_params(labelsize=9)

    ax_table = fig.add_axes([0.70, 0.31, 0.23, 0.39])
    ax_table.axis("off")
    ax_table.plot([0, 1], [0.98, 0.98], color="#1f1f1f", lw=0.9)
    ax_table.plot([0, 1], [0.08, 0.08], color="#1f1f1f", lw=0.9)
    ax_table.text(0.29, 0.89, "\u519c\u4e1a\u533a", ha="center", va="center", fontsize=11, fontproperties=bold_font)
    ax_table.text(
        0.79,
        0.89,
        "\u552f\u4e00\u7ecf\u7eac\u5ea6\u70b9\u4f4d\u6570",
        ha="center",
        va="center",
        fontsize=11,
        fontproperties=bold_font,
    )

    y = 0.75
    for zone in ZONE_ORDER:
        ax_table.text(0.29, y, zone, ha="center", va="center", fontsize=10.5, fontproperties=cn_font)
        ax_table.text(0.79, y, str(zone_counts.get(zone, 0)), ha="center", va="center", fontsize=10.5)
        y -= 0.105
    ax_table.text(0.29, y, ZONE_TOTAL, ha="center", va="center", fontsize=10.5, fontproperties=cn_font)
    ax_table.text(0.79, y, str(len(records)), ha="center", va="center", fontsize=10.5)

    return fig, zone_counts


def write_preview_html(png_path):
    image = Image.open(png_path).convert("RGB")
    preview_width = 1200
    preview_height = round(image.height * preview_width / image.width)
    image = image.resize((preview_width, preview_height), Image.Resampling.LANCZOS)
    preview_path = OUT_DIR / "soc_observation_sites_china_map_preview.jpg"
    image.save(preview_path, quality=86, optimize=True)
    encoded = base64.b64encode(preview_path.read_bytes()).decode("ascii")
    html_path = VIZ_DIR / "soc-observation-sites-china-map.html"
    html_path.write_text(
        f"""<div style=\"font-family:Arial,'Microsoft YaHei',sans-serif;background:#f4f6f8;padding:16px;box-sizing:border-box;width:100%;\">
  <div style=\"max-width:1200px;margin:0 auto;background:white;padding:0;box-shadow:0 1px 6px rgba(0,0,0,.08);\">
    <img alt=\"Spatial distribution of SOC observation sites in China\" src=\"data:image/jpeg;base64,{encoded}\" style=\"display:block;width:100%;height:auto;\" />
  </div>
</div>""",
        encoding="utf-8",
    )
    return html_path


def main():
    records, files_read, rows_seen, rows_with_coords_soc = load_sites()
    geo = load_geojson()
    fig, zone_counts = build_figure(records, geo)

    png_path = OUT_DIR / "soc_observation_sites_china_map.png"
    pdf_path = OUT_DIR / "soc_observation_sites_china_map.pdf"
    svg_path = OUT_DIR / "soc_observation_sites_china_map.svg"
    fig.savefig(png_path, dpi=220, bbox_inches="tight", facecolor="white")
    fig.savefig(pdf_path, bbox_inches="tight", facecolor="white")
    fig.savefig(svg_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    html_path = write_preview_html(png_path)

    print(
        json.dumps(
            {
                "outputs_json_read": files_read,
                "rows_seen_non_skipped": rows_seen,
                "rows_with_valid_coords_and_soc": rows_with_coords_soc,
                "unique_lon_lat_sites": len(records),
                "zone_counts": zone_counts,
                "png": str(png_path),
                "pdf": str(pdf_path),
                "svg": str(svg_path),
                "html": str(html_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
