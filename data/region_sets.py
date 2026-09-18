"""Convert a published boundary dataset into a region set the app can serve.

The app reads one shape: a FeatureCollection in WGS84 where every feature has an
`id` unique within the set and an `n` name. Published datasets each have their
own fields, CRS and level of detail, so the normalising belongs here rather than
in the browser — see public/regions/index.json.

Simplification is not optional. These boundaries are averaged onto 0.5 or 1.0
degree cells, so coastline detail finer than a kilometre is invisible to every
number the app produces and costs the user a download. The default tolerance is
two orders of magnitude finer than a cell.

Usage:
    python region_sets.py igrac-tba /path/to/tba_map_2025.shp

Run with no arguments to list the sets this knows how to build.
"""

import argparse
import json
import sys
from pathlib import Path

from osgeo import ogr, osr
from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

# Douglas-Peucker tolerance in degrees. 0.01 is ~1.1 km at the equator, which is
# still fifty times finer than the 0.5 degree cells these are averaged onto and
# well under a pixel at the zoom the region list is browsed at. It halves the
# download against 0.005 and nothing downstream can tell the difference.
DEFAULT_TOLERANCE = 0.01
# Coordinate decimals. 5 is ~1 m, still far finer than the tolerance above.
COORD_DECIMALS = 5

SETS = {
    "usgs-principal": {
        "label": "Principal Aquifers, USA (USGS)",
        "name_fields": ["AQ_NAME"],
        "id_field": "AQ_CODE",
        # One aquifer is drawn as many polygons — the coastal lowlands system
        # alone is 356 — so features are unioned by aquifer code into one region
        # each, which is also what "no interior boundaries" requires.
        "dissolve_by": "AQ_CODE",
        # A catch-all for everything that is not a principal aquifer. It is not a
        # region and would be the largest entry in the list.
        "exclude_ids": [999],
        "attribution": "Principal Aquifers of the United States, U.S. Geological Survey (public domain)",
        "source": "https://water.usgs.gov/GIS/metadata/usgswrd/XML/aquifers_us.xml",
    },
    "whymap-lgas": {
        "label": "Large Aquifer Systems (WHYMAP)",
        "name_fields": ["Aquifer_sy"],
        "id_field": "HYGEO",
        # Five of the 37 have a null name in the shapefile. HYGEO is the WHYMAP
        # number every published map of this set is labelled with, so the gaps
        # are filled from the literature rather than left as "Unnamed".
        #   8, 11, 12  read from Cuthbert et al. 2020 (ESD 11, 755), which writes
        #              them as "Name-number" in its text
        #   14         from the same paper's Table 1
        #   15         inferred: it is the only unaccounted number, the paper
        #              names the Cambrian-Ordovician system among the 37, and
        #              this polygon sits over Wisconsin/Illinois/Iowa where that
        #              aquifer is. Confirm against WHYMAP before relying on it.
        "name_overrides": {
            8: "Umm Ruwaba Aquifer (Sudd Basin)",
            11: "Upper Kalahari-Cuvelai-Zambezi Basin",
            12: "Lower Kalahari-Stampriet Basin",
            14: "Northern Great Plains Aquifer",
            15: "Cambro-Ordovician Aquifer System",
        },
        "attribution": (
            "Large Aquifer Systems of the World, WHYMAP (BGR/UNESCO), "
            "via UNESCO IHP-WINS"
        ),
        "source": "https://ihp-wins.unesco.org/dataset/large-aquifer-systems-of-the-world",
    },
    "igrac-tba": {
        "label": "Transboundary Aquifers (IGRAC)",
        # name_eng is populated for only 40 of the 426; `name` carries the rest.
        "name_fields": ["name_eng", "name"],
        "id_field": "code",
        "attribution": (
            "Transboundary Aquifers of the World 2025 © UNESCO-IHP / IGRAC, "
            "CC BY-SA 3.0 IGO"
        ),
        "source": "https://ihp-wins.unesco.org/en/dataset/2025-transboundary-aquifers-of-the-world",
    },
}


def polygonal(geom):
    """The polygon parts of a geometry, dropping anything make_valid left behind.

    Repairing a self-intersecting ring yields a GeometryCollection mixing
    polygons with the lines where the ring crossed itself; the lines are an
    artifact of the repair, not boundary.
    """
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if hasattr(geom, "geoms"):
        parts = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if parts:
            return unary_union(parts)
    return None


def round_coords(obj, nd=COORD_DECIMALS):
    if isinstance(obj, (list, tuple)):
        return [round_coords(o, nd) for o in obj]
    return round(obj, nd) if isinstance(obj, float) else obj


def read_features(shp_path):
    """Features as (properties, shapely geometry), reprojected to WGS84."""
    source = ogr.Open(str(shp_path))
    if source is None:
        raise SystemExit(f"Could not open {shp_path}")
    layer = source.GetLayer()

    wgs84 = osr.SpatialReference()
    wgs84.ImportFromEPSG(4326)
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    src_srs = layer.GetSpatialRef()
    transform = None
    if src_srs is not None:
        src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        if not src_srs.IsSame(wgs84):
            transform = osr.CoordinateTransformation(src_srs, wgs84)

    for feature in layer:
        geom = feature.GetGeometryRef()
        if geom is None:
            continue
        geom = geom.Clone()
        if transform is not None:
            geom.Transform(transform)
        geom.FlattenTo2D()
        yield feature.items(), shape(json.loads(geom.ExportToJson()))


def group_features(features, spec):
    """Union features that belong to the same region, when a set needs it.

    Some sources draw one aquifer as hundreds of polygons. Those are parts of a
    region, not regions, so they are dissolved before anything else — simplifying
    first would waste the work and leave seams between neighbouring parts.
    """
    key = spec.get("dissolve_by")
    excluded = set(spec.get("exclude_ids", []))
    if not key:
        for props, geom in features:
            if props.get(spec["id_field"]) not in excluded:
                yield props, geom
        return

    groups = {}
    for props, geom in features:
        gid = props.get(key)
        if gid in excluded:
            continue
        if gid in groups:
            groups[gid][1].append(geom)
        else:
            groups[gid] = (props, [geom])
    for props, geoms in groups.values():
        merged = unary_union(geoms) if len(geoms) > 1 else geoms[0]
        yield props, merged


def build(set_id, shp_path, out_dir, tolerance):
    spec = SETS[set_id]
    features = []
    seen_ids = set()
    stats = {"repaired": 0, "unnamed": 0, "filled": 0, "dropped": 0, "verts_in": 0, "verts_out": 0}

    def count(geom):
        if geom.geom_type == "Polygon":
            return len(geom.exterior.coords) + sum(len(i.coords) for i in geom.interiors)
        return sum(count(g) for g in geom.geoms) if hasattr(geom, "geoms") else 0

    for props, geom in group_features(read_features(shp_path), spec):
        if not geom.is_valid:
            stats["repaired"] += 1
            geom = polygonal(make_valid(geom)) or geom
        stats["verts_in"] += count(geom)

        simplified = geom.simplify(tolerance, preserve_topology=True)
        if not simplified.is_valid:
            simplified = polygonal(make_valid(simplified)) or geom
        if simplified.geom_type not in ("Polygon", "MultiPolygon") or simplified.is_empty:
            stats["dropped"] += 1
            continue
        stats["verts_out"] += count(simplified)

        name = next(
            (str(props[f]).strip() for f in spec["name_fields"] if (props.get(f) or "").strip()),
            None,
        )
        if name is None:
            name = spec.get("name_overrides", {}).get(props.get(spec["id_field"]))
            if name:
                stats["filled"] += 1
        if name is None:
            stats["unnamed"] += 1
            name = f"Unnamed ({props.get(spec['id_field'])})"

        # The id has to be unique within the set: the app keys selection, trend
        # classification and the definitionExpression off it.
        rid = str(props.get(spec["id_field"]) or "").strip() or f"f{len(features)}"
        if rid in seen_ids:
            rid = f"{rid}-{len(features)}"
        seen_ids.add(rid)

        features.append({
            "type": "Feature",
            "properties": {"id": rid, "n": name},
            "geometry": round_coords(mapping(simplified)),
        })

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{set_id}.geojson"
    out_path.write_text(json.dumps(
        {"type": "FeatureCollection", "features": features}, separators=(",", ":")
    ))

    update_manifest(out_dir, set_id, spec, out_path)

    kb = out_path.stat().st_size / 1024
    print(f"{out_path}: {len(features)} regions, {kb:,.0f} KB")
    print(f"  vertices {stats['verts_in']:,} -> {stats['verts_out']:,} at {tolerance} deg")
    for key, label in (("repaired", "repaired invalid"), ("filled", "named from overrides"),
                       ("unnamed", "still unnamed"), ("dropped", "dropped")):
        if stats[key]:
            print(f"  {stats[key]} {label}")


def update_manifest(out_dir, set_id, spec, out_path):
    """Add or refresh this set's entry, leaving the others alone."""
    manifest_path = out_dir / "index.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"sets": []}
    entry = {
        "id": set_id,
        "label": spec["label"],
        "file": out_path.name,
        "attribution": spec["attribution"],
        "source": spec["source"],
    }
    sets = [s for s in manifest.get("sets", []) if s.get("id") != set_id]
    sets.append(entry)
    manifest["sets"] = sets
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("set_id", nargs="?", choices=sorted(SETS), help="which set to build")
    parser.add_argument("shapefile", nargs="?", help="path to the source .shp")
    parser.add_argument("--out", default=str(Path(__file__).parent.parent / "public" / "regions"))
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE,
                        help=f"simplification tolerance in degrees (default {DEFAULT_TOLERANCE})")
    args = parser.parse_args()

    if not args.set_id or not args.shapefile:
        print("Known sets:")
        for sid, spec in sorted(SETS.items()):
            print(f"  {sid:<12} {spec['label']}")
            print(f"               {spec['source']}")
        sys.exit(0 if not args.set_id else 2)

    build(args.set_id, Path(args.shapefile), Path(args.out), args.tolerance)


if __name__ == "__main__":
    main()
