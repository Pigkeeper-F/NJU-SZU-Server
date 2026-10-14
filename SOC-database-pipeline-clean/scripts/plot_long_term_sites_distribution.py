from __future__ import annotations

import json
import math
import re
import urllib.request
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


DATA_XLSX = Path(r"C:\Users\31307\Desktop\SOC model\data.xlsx")
OUT_DIR = Path(r"C:\Users\31307\Desktop\SOC model\map_outputs")
GEOJSON = OUT_DIR / "china_provinces_100000_full.json"
GEOJSON_URL = "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json"


REGION_RULES = [
    ("Northeast", ["黑龙江", "吉林", "辽宁", "Heilongjiang", "Jilin", "Liaoning"]),
    ("North China Plain", ["北京", "天津", "河北", "山东", "河南", "山西", "Beijing", "Tianjin", "Hebei", "Shandong", "Henan", "Shanxi"]),
    ("Northwest", ["新疆", "甘肃", "宁夏", "青海", "陕西", "内蒙古", "Xinjiang", "Gansu", "Ningxia", "Qinghai", "Shaanxi", "Inner Mongolia"]),
    ("Middle-Lower Yangtze", ["上海", "江苏", "安徽", "浙江", "湖北", "湖南", "江西", "Shanghai", "Jiangsu", "Anhui", "Zhejiang", "Hubei", "Hunan", "Jiangxi"]),
    ("Southwest", ["四川", "重庆", "云南", "贵州", "西藏", "Sichuan", "Chongqing", "Yunnan", "Guizhou", "Tibet"]),
    ("South China", ["广东", "广西", "福建", "海南", "Guangdong", "Guangxi", "Fujian", "Hainan"]),
]


def flatten_columns(cols: pd.MultiIndex) -> list[str]:
    names: list[str] = []
    for a, b in cols:
        a = "" if str(a).startswith("Unnamed:") else str(a).strip()
        b = "" if str(b).startswith("Unnamed:") else str(b).strip()
        names.append(a if not b else f"{a}.{b}")
    return names


def read_sheet(sheet: str) -> pd.DataFrame:
    df = pd.read_excel(DATA_XLSX, sheet_name=sheet, header=[0, 1])
    df.columns = flatten_columns(df.columns)
    return df


def find_col(columns: list[str], *needles: str) -> str:
    normalized = {re.sub(r"\s+", "", c): c for c in columns}
    for compact, original in normalized.items():
        if all(n in compact for n in needles):
            return original
    raise KeyError(f"Column not found for {needles}")


def classify_region(region_text: str, lon: float, lat: float) -> str:
    text = "" if pd.isna(region_text) else str(region_text)
    for label, tokens in REGION_RULES:
        if any(token in text for token in tokens):
            return label
    if lat >= 41 and lon >= 118:
        return "Northeast"
    if lon < 103 and lat >= 31:
        return "Northwest"
    if lon < 110 and lat < 32:
        return "Southwest"
    if 111 <= lon <= 123 and 28 <= lat <= 33.8:
        return "Middle-Lower Yangtze"
    if lat < 27 and lon >= 108:
        return "South China"
    return "North China Plain"


def iter_polygon_rings(geometry: dict):
    coords = geometry.get("coordinates", [])
    if geometry.get("type") == "Polygon":
        for ring in coords:
            yield ring
    elif geometry.get("type") == "MultiPolygon":
        for poly in coords:
            for ring in poly:
                yield ring


def ensure_geojson() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not GEOJSON.exists():
        urllib.request.urlretrieve(GEOJSON_URL, GEOJSON)
    return json.loads(GEOJSON.read_text(encoding="utf-8"))


def draw_boundaries(ax, geo: dict) -> None:
    for feature in geo.get("features", []):
        geom = feature.get("geometry", {})
        for ring in iter_polygon_rings(geom):
            if not ring:
                continue
            xs = [p[0] for p in ring if len(p) >= 2 and math.isfinite(p[0]) and math.isfinite(p[1])]
            ys = [p[1] for p in ring if len(p) >= 2 and math.isfinite(p[0]) and math.isfinite(p[1])]
            if len(xs) > 1:
                ax.plot(xs, ys, color="#c8d1cb", linewidth=0.55, zorder=1)


def main() -> None:
    long_df = read_sheet("长期定位试验")
    point_df = read_sheet("点位试验")

    lon_col = find_col(list(long_df.columns), "点位信息", "经度")
    lat_col = find_col(list(long_df.columns), "点位信息", "纬度")
    region_col = find_col(list(long_df.columns), "点位信息", "Region")
    soc_col = find_col(list(long_df.columns), "SOC.SOC", "0-30cm")

    long_df[lon_col] = pd.to_numeric(long_df[lon_col], errors="coerce")
    long_df[lat_col] = pd.to_numeric(long_df[lat_col], errors="coerce")
    long_df[soc_col] = pd.to_numeric(long_df[soc_col], errors="coerce")

    valid = long_df.dropna(subset=[lon_col, lat_col, soc_col]).copy()
    valid = valid[(valid[lon_col].between(70, 140)) & (valid[lat_col].between(15, 55))]
    valid["lon_round"] = valid[lon_col].round(4)
    valid["lat_round"] = valid[lat_col].round(4)
    valid["macro_region"] = [
        classify_region(r, lo, la) for r, lo, la in zip(valid[region_col], valid[lon_col], valid[lat_col])
    ]

    site = (
        valid.groupby(["lon_round", "lat_round"], as_index=False)
        .agg(
            lon=(lon_col, "mean"),
            lat=(lat_col, "mean"),
            mean_soc=(soc_col, "mean"),
            n_rows=("No.", "size"),
            n_articles=("No.", pd.Series.nunique),
            region_text=(region_col, "first"),
            macro_region=("macro_region", "first"),
        )
        .sort_values(["macro_region", "lon", "lat"])
    )

    region_articles = valid.groupby("macro_region")["No."].nunique().rename("unique_articles")
    region_stats = (
        site.groupby("macro_region", as_index=False)
        .agg(unique_sites=("mean_soc", "size"), mean_soc_g_kg=("mean_soc", "mean"))
        .merge(region_articles, on="macro_region", how="left")
        .sort_values("unique_sites", ascending=False)
    )

    summary = {
        "source_workbook": str(DATA_XLSX),
        "long_term_article_count_unique_no": int(long_df["No."].dropna().nunique()),
        "point_article_count_unique_no": int(point_df["No."].dropna().nunique()),
        "long_term_rows": int(long_df["No."].notna().sum()),
        "long_term_rows_with_valid_lon_lat_soc": int(len(valid)),
        "unique_lon_lat_sites_with_soc": int(len(site)),
        "mean_site_soc_g_kg": round(float(site["mean_soc"].mean()), 2),
        "median_site_soc_g_kg": round(float(site["mean_soc"].median()), 2),
        "min_site_soc_g_kg": round(float(site["mean_soc"].min()), 2),
        "max_site_soc_g_kg": round(float(site["mean_soc"].max()), 2),
        "region_stats": region_stats.round({"mean_soc_g_kg": 2}).to_dict(orient="records"),
    }

    site_csv = OUT_DIR / "long_term_soc_site_distribution_points.csv"
    region_csv = OUT_DIR / "long_term_soc_site_distribution_region_stats.csv"
    summary_json = OUT_DIR / "long_term_soc_site_distribution_summary.json"
    out_png = OUT_DIR / "long_term_soc_sites_distribution_map.png"

    site.round({"lon": 5, "lat": 5, "mean_soc": 3}).to_csv(site_csv, index=False, encoding="utf-8-sig")
    region_stats.round({"mean_soc_g_kg": 2}).to_csv(region_csv, index=False, encoding="utf-8-sig")
    summary_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    geo = ensure_geojson()
    plt.rcParams.update({"font.family": "DejaVu Sans", "axes.unicode_minus": False})
    fig, ax = plt.subplots(figsize=(10.2, 6.0), dpi=180)
    draw_boundaries(ax, geo)
    sc = ax.scatter(
        site["lon"],
        site["lat"],
        c=site["mean_soc"],
        s=18,
        cmap="YlOrBr",
        edgecolors="white",
        linewidths=0.25,
        alpha=0.92,
        zorder=3,
    )

    ax.set_title("Spatial distribution of long-term SOC observation sites in China", loc="left", fontsize=14, fontweight="bold", pad=12)
    ax.text(73.6, 52.8, f"Unique lon-lat sites: {len(site)}", fontsize=9.5, va="top", ha="left",
            bbox=dict(facecolor="white", edgecolor="#aab5b0", boxstyle="round,pad=0.25", alpha=0.9))

    labels = {
        "Northeast": (124.0, 44.8),
        "North China Plain": (113.4, 36.0),
        "Northwest": (100.5, 36.0),
        "Middle-Lower Yangtze": (112.8, 30.3),
        "Southwest": (103.4, 26.8),
        "South China": (111.1, 23.3),
    }
    for label, (x, y) in labels.items():
        ax.text(x, y, label, fontsize=8.2, color="#5a5f5d", zorder=4)

    ax.set_xlim(73, 136)
    ax.set_ylim(18, 54)
    ax.set_xlabel("Longitude (deg E)", fontsize=10)
    ax.set_ylabel("Latitude (deg N)", fontsize=10)
    ax.grid(True, color="#d9dfdc", linewidth=0.5, alpha=0.65)
    for spine in ax.spines.values():
        spine.set_color("#9aa8a2")
    cbar = fig.colorbar(sc, ax=ax, fraction=0.035, pad=0.02)
    cbar.set_label("Mean SOC content (g kg$^{-1}$)", fontsize=9.5)
    fig.tight_layout()
    fig.savefig(out_png, bbox_inches="tight", facecolor="white")
    plt.close(fig)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"MAP={out_png}")
    print(f"SITES={site_csv}")
    print(f"REGIONS={region_csv}")
    print(f"SUMMARY={summary_json}")


if __name__ == "__main__":
    main()
