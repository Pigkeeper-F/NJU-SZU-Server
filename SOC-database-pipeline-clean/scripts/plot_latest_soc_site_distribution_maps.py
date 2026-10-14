from __future__ import annotations

import json
import math
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


DATA_XLSX = Path(r"C:\Users\31307\Desktop\SOC model\data.xlsx")
OUT_DIR = Path(r"C:\Users\31307\Desktop\SOC model\map_outputs")
CHINA_GEOJSON = OUT_DIR / "china_provinces_datav_100000_full.json"
RUN_DATE = "20260830"

SHEETS = {
    "point_site": {
        "sheet": "点位试验",
        "title": "Spatial distribution of point-site SOC observation sites in China",
        "label": "Point-site experiments",
        "prefix": f"point_site_soc_sites_distribution_{RUN_DATE}",
    },
    "long_term": {
        "sheet": "长期定位试验",
        "title": "Spatial distribution of long-term SOC observation sites in China",
        "label": "Long-term positioning experiments",
        "prefix": f"long_term_soc_sites_distribution_{RUN_DATE}",
    },
}

REGION_LABELS = {
    "Northwest": (100.5, 35.7),
    "North China Plain": (112.0, 35.8),
    "Northeast": (124.0, 44.8),
    "Middle-Lower Yangtze": (111.0, 30.2),
    "Southwest": (101.0, 26.7),
    "South China": (108.8, 23.2),
}

REGION_RULES = [
    ("Northeast", ["黑龙江", "吉林", "辽宁", "Heilongjiang", "Jilin", "Liaoning", "Northeast"]),
    (
        "North China Plain",
        ["北京", "天津", "河北", "山东", "河南", "山西", "Beijing", "Tianjin", "Hebei", "Shandong", "Henan", "Shanxi", "North China"],
    ),
    (
        "Northwest",
        ["新疆", "甘肃", "宁夏", "青海", "陕西", "内蒙古", "Xinjiang", "Gansu", "Ningxia", "Qinghai", "Shaanxi", "Inner Mongolia", "Northwest"],
    ),
    (
        "Middle-Lower Yangtze",
        ["上海", "江苏", "安徽", "浙江", "湖北", "湖南", "江西", "Shanghai", "Jiangsu", "Anhui", "Zhejiang", "Hubei", "Hunan", "Jiangxi", "Yangtze"],
    ),
    ("Southwest", ["四川", "重庆", "云南", "贵州", "西藏", "Sichuan", "Chongqing", "Yunnan", "Guizhou", "Tibet", "Southwest"]),
    ("South China", ["广东", "广西", "福建", "海南", "Guangdong", "Guangxi", "Fujian", "Hainan", "South China"]),
]


def flatten_columns(columns: pd.MultiIndex) -> list[str]:
    names = []
    for first, second in columns:
        first = "" if str(first).startswith("Unnamed:") else str(first).strip()
        second = "" if str(second).startswith("Unnamed:") else str(second).strip()
        names.append(first if not second else f"{first}.{second}")
    return names


def parse_coord(value) -> float:
    if pd.isna(value):
        return np.nan
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)

    text = str(value).strip()
    if not text:
        return np.nan
    text = (
        text.replace("−", "-")
        .replace("～", "-")
        .replace("—", "-")
        .replace("–", "-")
        .replace("－", "-")
        .replace("?", "°")
    )
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", text)]
    if not nums:
        return np.nan

    has_dms = any(mark in text for mark in ("°", "'", '"', "′", "″", "度", "分", "秒"))
    if has_dms:
        if len(nums) >= 6:
            vals = [nums[0] + nums[1] / 60 + nums[2] / 3600, nums[3] + nums[4] / 60 + nums[5] / 3600]
            return float(np.mean(vals))
        if len(nums) >= 4:
            vals = [nums[0] + nums[1] / 60, nums[2] + nums[3] / 60]
            return float(np.mean(vals))
        if len(nums) >= 3:
            return float(nums[0] + nums[1] / 60 + nums[2] / 3600)
        if len(nums) >= 2:
            return float(nums[0] + nums[1] / 60)

    if "-" in text and len(nums) >= 2:
        return float(np.mean(nums[:2]))
    return float(nums[0])


def find_col(columns: list[str], *needles: str) -> str | None:
    compacted = [(re.sub(r"\s+", "", col), col) for col in columns]
    for compact, original in compacted:
        if all(needle in compact for needle in needles):
            return original
    return None


def soc_columns(columns: list[str]) -> list[str]:
    selected = []
    for col in columns:
        compact = re.sub(r"\s+", "", col).upper()
        leaf = re.sub(r"\s+", "", col.split(".")[-1]).upper()
        if "SOC" not in leaf:
            continue
        if any(bad in compact for bad in ["POC", "MAOC", "DOC", "MBC", "STOCK", "DENSITY", "原始", "ORIGINAL", "单位"]):
            continue
        selected.append(col)
    selected.sort(key=lambda c: (0 if "0-30" in re.sub(r"\s+", "", c) else 1, 0 if "(g/kg)" in c else 1))
    return selected


def load_sheet_sites(sheet_name: str) -> tuple[pd.DataFrame, dict]:
    df = pd.read_excel(DATA_XLSX, sheet_name=sheet_name, header=[0, 1])
    df.columns = flatten_columns(df.columns)

    lon_col = find_col(list(df.columns), "点位信息", "经度")
    lat_col = find_col(list(df.columns), "点位信息", "纬度")
    region_col = find_col(list(df.columns), "点位信息", "Region")
    if lon_col is None or lat_col is None:
        raise KeyError(f"Could not find longitude/latitude columns in {sheet_name}")

    work = df.copy()
    work["No_clean"] = work["No."].astype(str).str.replace(r"\.0$", "", regex=True)
    work["lon"] = work[lon_col].apply(parse_coord)
    work["lat"] = work[lat_col].apply(parse_coord)

    soc_cols = soc_columns(list(work.columns))
    if not soc_cols:
        raise KeyError(f"Could not find SOC columns in {sheet_name}")
    soc_values = pd.DataFrame({col: pd.to_numeric(work[col], errors="coerce") for col in soc_cols})
    work["soc"] = soc_values.bfill(axis=1).iloc[:, 0]

    valid = work[
        work["lon"].between(73, 136)
        & work["lat"].between(18, 54)
        & work["soc"].notna()
        & work["soc"].between(0, 300)
    ].copy()
    valid["lon_round"] = valid["lon"].round(4)
    valid["lat_round"] = valid["lat"].round(4)
    valid["region"] = [
        classify_region(region_text, lon, lat)
        for region_text, lon, lat in zip(valid[region_col] if region_col else "", valid["lon"], valid["lat"])
    ]

    sites = (
        valid.groupby(["lon_round", "lat_round"], as_index=False)
        .agg(
            lon=("lon", "mean"),
            lat=("lat", "mean"),
            soc_mean=("soc", "mean"),
            soc_median=("soc", "median"),
            article_count=("No_clean", "nunique"),
            row_count=("soc", "size"),
            region=("region", "first"),
        )
        .sort_values(["lat", "lon"])
    )

    summary = {
        "sheet": sheet_name,
        "rows": int(len(df)),
        "unique_articles": int(df["No."].dropna().nunique()),
        "rows_with_valid_lon_lat_soc": int(len(valid)),
        "unique_lon_lat_sites": int(len(sites)),
        "soc_columns_used_in_priority_order": soc_cols,
        "mean_site_soc_g_kg": round(float(sites["soc_mean"].mean()), 2) if len(sites) else None,
        "median_site_soc_g_kg": round(float(sites["soc_mean"].median()), 2) if len(sites) else None,
        "min_site_soc_g_kg": round(float(sites["soc_mean"].min()), 2) if len(sites) else None,
        "max_site_soc_g_kg": round(float(sites["soc_mean"].max()), 2) if len(sites) else None,
    }
    return sites, summary


def classify_region(region_text, lon: float, lat: float) -> str:
    text = "" if pd.isna(region_text) else str(region_text)
    for label, tokens in REGION_RULES:
        if any(token in text for token in tokens):
            return label
    if lon >= 121 and lat >= 40:
        return "Northeast"
    if lon <= 106 and lat >= 32:
        return "Northwest"
    if lon <= 108 and lat < 32:
        return "Southwest"
    if 110 <= lon <= 123 and 27 <= lat < 33.5:
        return "Middle-Lower Yangtze"
    if lon >= 108 and lat < 27:
        return "South China"
    return "North China Plain"


def iter_rings(geometry: dict):
    coords = geometry.get("coordinates", [])
    if geometry.get("type") == "Polygon":
        yield from coords
    elif geometry.get("type") == "MultiPolygon":
        for polygon in coords:
            yield from polygon


def load_geojson() -> dict:
    if not CHINA_GEOJSON.exists():
        raise FileNotFoundError(f"Missing China boundary GeoJSON: {CHINA_GEOJSON}")
    return json.loads(CHINA_GEOJSON.read_text(encoding="utf-8"))


def draw_boundaries(ax, china: dict) -> None:
    for feature in china.get("features", []):
        for ring in iter_rings(feature.get("geometry", {})):
            arr = np.asarray(ring)
            if arr.ndim == 2 and arr.shape[1] >= 2:
                ax.fill(arr[:, 0], arr[:, 1], facecolor="#f8faf8", edgecolor="#c5d0cb", linewidth=0.55, zorder=1)


def draw_map(ax, sites: pd.DataFrame, china: dict, title: str) -> None:
    draw_boundaries(ax, china)
    vmax = float(np.nanpercentile(sites["soc_mean"], 98)) if len(sites) else 35.0
    vmin = float(np.nanpercentile(sites["soc_mean"], 2)) if len(sites) else 0.0
    if not math.isfinite(vmin) or not math.isfinite(vmax) or vmin >= vmax:
        vmin, vmax = 0.0, 35.0

    scatter = ax.scatter(
        sites["lon"],
        sites["lat"],
        c=sites["soc_mean"],
        s=np.clip(11 + np.sqrt(sites["article_count"]) * 7, 13, 42),
        cmap="YlOrBr",
        vmin=vmin,
        vmax=vmax,
        edgecolor="white",
        linewidth=0.25,
        alpha=0.92,
        zorder=3,
    )

    for label, (lon, lat) in REGION_LABELS.items():
        ax.text(lon, lat, label, fontsize=8, color="#5f6663", zorder=4)

    ax.text(
        73.8,
        52.7,
        f"Unique lon-lat sites: {len(sites)}",
        fontsize=9,
        bbox=dict(boxstyle="round,pad=0.22", facecolor="white", edgecolor="#9aa8a2", linewidth=0.6),
        zorder=5,
    )
    ax.set_xlim(73, 136)
    ax.set_ylim(18, 54)
    ax.set_xticks(np.arange(80, 136, 10))
    ax.set_yticks(np.arange(20, 55, 5))
    ax.grid(color="#d9dfdc", linewidth=0.6, alpha=0.55)
    ax.set_xlabel("Longitude (deg E)")
    ax.set_ylabel("Latitude (deg N)")
    ax.set_title(title, loc="left", fontsize=13.5, weight="bold")
    for spine in ax.spines.values():
        spine.set_color("#9aa8a2")
        spine.set_linewidth(0.8)
    return scatter


def region_stats(sites: pd.DataFrame) -> pd.DataFrame:
    stats = (
        sites.groupby("region", as_index=False)
        .agg(
            unique_lon_lat_sites=("soc_mean", "size"),
            represented_articles=("article_count", "sum"),
            coordinate_soc_rows=("row_count", "sum"),
            mean_site_soc_g_kg=("soc_mean", "mean"),
            median_site_soc_g_kg=("soc_mean", "median"),
        )
        .sort_values("unique_lon_lat_sites", ascending=False)
    )
    total = pd.DataFrame(
        [
            {
                "region": "China total",
                "unique_lon_lat_sites": int(len(sites)),
                "represented_articles": int(sites["article_count"].sum()),
                "coordinate_soc_rows": int(sites["row_count"].sum()),
                "mean_site_soc_g_kg": float(sites["soc_mean"].mean()),
                "median_site_soc_g_kg": float(sites["soc_mean"].median()),
            }
        ]
    )
    return pd.concat([total, stats], ignore_index=True)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    china = load_geojson()
    plt.rcParams.update({"font.family": "DejaVu Sans", "axes.unicode_minus": False})

    results = {}
    rendered = {}
    for key, config in SHEETS.items():
        sites, summary = load_sheet_sites(config["sheet"])
        stats = region_stats(sites)

        points_csv = OUT_DIR / f"{config['prefix']}_points.csv"
        stats_csv = OUT_DIR / f"{config['prefix']}_region_stats.csv"
        png = OUT_DIR / f"{config['prefix']}_map.png"
        pdf = OUT_DIR / f"{config['prefix']}_map.pdf"
        svg = OUT_DIR / f"{config['prefix']}_map.svg"

        sites.round({"lon": 5, "lat": 5, "soc_mean": 3, "soc_median": 3}).to_csv(points_csv, index=False, encoding="utf-8-sig")
        stats.round({"mean_site_soc_g_kg": 2, "median_site_soc_g_kg": 2}).to_csv(stats_csv, index=False, encoding="utf-8-sig")

        fig, ax = plt.subplots(figsize=(10.2, 6.0), dpi=180)
        sc = draw_map(ax, sites, china, config["title"])
        cbar = fig.colorbar(sc, ax=ax, pad=0.02, shrink=0.86)
        cbar.set_label("Mean SOC content (g kg$^{-1}$)")
        fig.tight_layout()
        fig.savefig(png, bbox_inches="tight", facecolor="white")
        fig.savefig(pdf, bbox_inches="tight", facecolor="white")
        fig.savefig(svg, bbox_inches="tight", facecolor="white")
        plt.close(fig)

        summary.update(
            {
                "points_csv": str(points_csv),
                "region_stats_csv": str(stats_csv),
                "map_png": str(png),
                "map_pdf": str(pdf),
                "map_svg": str(svg),
            }
        )
        results[key] = summary
        rendered[key] = (sites, config)

    combined_png = OUT_DIR / f"soc_sites_distribution_point_vs_long_term_{RUN_DATE}.png"
    fig, axes = plt.subplots(1, 2, figsize=(16, 5.8), dpi=180)
    for ax, key in zip(axes, ["point_site", "long_term"]):
        sites, config = rendered[key]
        sc = draw_map(ax, sites, china, config["label"])
    cbar = fig.colorbar(sc, ax=axes.ravel().tolist(), pad=0.012, shrink=0.84)
    cbar.set_label("Mean SOC content (g kg$^{-1}$)")
    fig.savefig(combined_png, bbox_inches="tight", facecolor="white")
    plt.close(fig)

    summary_path = OUT_DIR / f"soc_sites_distribution_summary_{RUN_DATE}.json"
    summary = {
        "source_workbook": str(DATA_XLSX),
        "run_date": RUN_DATE,
        "outputs": results,
        "combined_map_png": str(combined_png),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
