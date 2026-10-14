import json
import re
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


DATA_XLSX = Path(r"C:\Users\31307\Desktop\SOC model\data.xlsx")
CHINA_GEOJSON = Path(r"C:\Users\31307\Desktop\SOC model\map_outputs\china_provinces_datav_100000_full.json")
OUT_DIR = Path(r"C:\Users\31307\Desktop\SOC model\map_outputs")
OUT_PNG = OUT_DIR / "long_term_soc_sites_distribution_20260828.png"
OUT_CSV = OUT_DIR / "long_term_soc_sites_distribution_stats_20260828.csv"


def parse_coord(value):
    if pd.isna(value):
        return np.nan
    text = str(value).strip()
    if not text:
        return np.nan
    text = (
        text.replace("−", "-")
        .replace("～", "-")
        .replace("—", "-")
        .replace("–", "-")
        .replace("－", "-")
    )
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", text)]
    if not nums:
        return np.nan

    has_dms_mark = any(mark in text for mark in ("'", '"', "′", "″", "��", "°", "度", "分", "秒"))
    if has_dms_mark:
        vals = []
        if len(nums) >= 6:
            vals = [nums[0] + nums[1] / 60 + nums[2] / 3600, nums[3] + nums[4] / 60 + nums[5] / 3600]
        elif len(nums) >= 4:
            vals = [nums[0] + nums[1] / 60, nums[2] + nums[3] / 60]
        elif len(nums) >= 3:
            vals = [nums[0] + nums[1] / 60 + nums[2] / 3600]
        elif len(nums) >= 2:
            vals = [nums[0] + nums[1] / 60]
        if vals:
            return float(np.mean(vals))

    if "-" in text and len(nums) >= 2:
        return float(np.mean(nums[:2]))
    return nums[0]


def iter_rings(geometry):
    gtype = geometry.get("type")
    coords = geometry.get("coordinates", [])
    if gtype == "Polygon":
        for ring in coords:
            yield ring
    elif gtype == "MultiPolygon":
        for polygon in coords:
            for ring in polygon:
                yield ring


def macro_region(lon, lat):
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


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    df = pd.read_excel(DATA_XLSX, sheet_name=1).iloc[1:].copy()
    df["No_clean"] = df.iloc[:, 0].astype(str).str.replace(r"\.0$", "", regex=True)
    df["lon"] = df.iloc[:, 7].apply(parse_coord)
    df["lat"] = df.iloc[:, 8].apply(parse_coord)
    df["soc"] = pd.to_numeric(df.iloc[:, 17], errors="coerce")

    valid_coord = (
        df["lon"].notna()
        & df["lat"].notna()
        & df["lon"].between(73, 136)
        & df["lat"].between(18, 54)
    )
    valid_soc = valid_coord & df["soc"].notna()
    coord_soc = df.loc[valid_soc, ["No_clean", "lon", "lat", "soc"]].copy()
    coord_soc["lon_round"] = coord_soc["lon"].round(4)
    coord_soc["lat_round"] = coord_soc["lat"].round(4)

    sites = (
        coord_soc.groupby(["lon_round", "lat_round"], as_index=False)
        .agg(
            lon=("lon", "mean"),
            lat=("lat", "mean"),
            soc_mean=("soc", "mean"),
            soc_median=("soc", "median"),
            article_count=("No_clean", "nunique"),
            row_count=("soc", "size"),
        )
        .sort_values(["lat", "lon"])
    )
    sites["region"] = [macro_region(lon, lat) for lon, lat in zip(sites["lon"], sites["lat"])]

    overall = pd.DataFrame(
        [
            {
                "region": "China total",
                "unique_lon_lat_sites": len(sites),
                "unique_articles": df["No_clean"].replace("nan", np.nan).dropna().nunique(),
                "coordinate_rows": int(valid_coord.sum()),
                "soc_coordinate_rows": int(valid_soc.sum()),
                "mean_site_soc_g_kg": sites["soc_mean"].mean(),
                "median_site_soc_g_kg": sites["soc_mean"].median(),
            }
        ]
    )
    region_stats = (
        sites.groupby("region", as_index=False)
        .agg(
            unique_lon_lat_sites=("soc_mean", "size"),
            unique_articles=("article_count", "sum"),
            coordinate_rows=("row_count", "sum"),
            soc_coordinate_rows=("row_count", "sum"),
            mean_site_soc_g_kg=("soc_mean", "mean"),
            median_site_soc_g_kg=("soc_mean", "median"),
        )
        .sort_values("unique_lon_lat_sites", ascending=False)
    )
    pd.concat([overall, region_stats], ignore_index=True).to_csv(OUT_CSV, index=False, encoding="utf-8-sig")

    china = json.loads(CHINA_GEOJSON.read_text(encoding="utf-8"))
    fig, ax = plt.subplots(figsize=(11, 7), dpi=180)
    ax.set_facecolor("white")

    for feature in china["features"]:
        for ring in iter_rings(feature["geometry"]):
            arr = np.asarray(ring)
            if arr.ndim == 2 and arr.shape[1] >= 2:
                ax.fill(arr[:, 0], arr[:, 1], facecolor="#f8faf8", edgecolor="#c5d0cb", linewidth=0.55, zorder=1)

    sc = ax.scatter(
        sites["lon"],
        sites["lat"],
        c=sites["soc_mean"],
        s=np.clip(10 + np.sqrt(sites["article_count"]) * 9, 14, 44),
        cmap="YlOrBr",
        vmin=max(0, np.nanpercentile(sites["soc_mean"], 2)),
        vmax=np.nanpercentile(sites["soc_mean"], 98),
        edgecolor="white",
        linewidth=0.25,
        alpha=0.92,
        zorder=3,
    )

    labels = [
        ("Northwest", 101.0, 35.5),
        ("North China Plain", 111.5, 35.7),
        ("Northeast", 123.5, 45.0),
        ("Middle-Lower Yangtze", 111.2, 30.3),
        ("Southwest", 100.0, 26.7),
        ("South China", 108.2, 23.2),
    ]
    for label, lon, lat in labels:
        ax.text(lon, lat, label, fontsize=8, color="#696969", zorder=4)

    ax.text(
        73.8,
        52.7,
        f"Unique lon-lat sites: {len(sites)}",
        fontsize=9,
        bbox=dict(boxstyle="round,pad=0.2", facecolor="white", edgecolor="#9aa8a2", linewidth=0.6),
        zorder=5,
    )

    ax.set_xlim(73, 136)
    ax.set_ylim(18, 54)
    ax.set_xticks(np.arange(80, 136, 10))
    ax.set_yticks(np.arange(20, 55, 5))
    ax.grid(color="#d9dfdc", linewidth=0.6, alpha=0.55)
    ax.set_xlabel("Longitude (deg E)")
    ax.set_ylabel("Latitude (deg N)")
    ax.set_title("Spatial distribution of long-term SOC observation sites in China", loc="left", fontsize=14, weight="bold")
    cbar = fig.colorbar(sc, ax=ax, pad=0.02, shrink=0.86)
    cbar.set_label("Mean SOC content (g kg$^{-1}$)")
    for spine in ax.spines.values():
        spine.set_color("#9aa8a2")
        spine.set_linewidth(0.8)
    fig.tight_layout()
    fig.savefig(OUT_PNG, bbox_inches="tight")

    print(json.dumps({
        "output_png": str(OUT_PNG),
        "output_csv": str(OUT_CSV),
        "unique_articles": int(overall.loc[0, "unique_articles"]),
        "unique_lon_lat_sites": int(len(sites)),
        "coordinate_rows": int(valid_coord.sum()),
        "soc_coordinate_rows": int(valid_soc.sum()),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
