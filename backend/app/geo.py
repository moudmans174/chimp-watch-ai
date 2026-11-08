"""Geometry helpers and sensitive-location generalisation."""
import math

from geoalchemy2.shape import from_shape, to_shape
from shapely.geometry import MultiPolygon, Point, mapping, shape
from shapely.ops import unary_union

from .config import get_settings
from .models import User


def point(lat: float, lon: float):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Coordinates out of range")
    return from_shape(Point(lon, lat), srid=4326)


def _geometry_from_any(geojson: dict):
    """Accept a bare geometry, a Feature, or a FeatureCollection (all polygons are merged)."""
    t = geojson.get("type")
    if t == "Feature":
        return shape(geojson["geometry"])
    if t == "FeatureCollection":
        parts = [shape(f["geometry"]) for f in geojson.get("features", []) if f.get("geometry")]
        if not parts:
            raise ValueError("The file has no features")
        return unary_union(parts)
    return shape(geojson)


def multipolygon_from_geojson(geojson: dict):
    g = _geometry_from_any(geojson)
    if not g.is_valid:
        g = g.buffer(0)
    if g.geom_type == "Polygon":
        g = MultiPolygon([g])
    if g.geom_type != "MultiPolygon" or not g.is_valid:
        raise ValueError("Boundary must be a valid Polygon or MultiPolygon")
    return from_shape(g, srid=4326)


def lonlat(geom) -> tuple[float, float] | None:
    if geom is None:
        return None
    p = to_shape(geom)
    return p.x, p.y


def geom_geojson(geom) -> dict | None:
    return mapping(to_shape(geom)) if geom is not None else None


def generalise(lon: float, lat: float, cell: float) -> tuple[float, float]:
    """Snap a coordinate to the centre of a grid cell so precise sites cannot be recovered."""
    gx = (math.floor(lon / cell) + 0.5) * cell
    gy = (math.floor(lat / cell) + 0.5) * cell
    return round(gx, 5), round(gy, 5)


def visible_location(geom, sensitive: bool, user: User | None) -> dict | None:
    """Return the location a given user is allowed to see.

    Precise coordinates are returned only to users granted sensitive-location access.
    Everyone else gets a generalised grid-cell centre and an explicit flag.
    """
    ll = lonlat(geom)
    if ll is None:
        return None
    lon, lat = ll
    if sensitive and not (user and user.can_view_sensitive):
        cell = get_settings().location_generalisation_deg
        glon, glat = generalise(lon, lat, cell)
        return {"lon": glon, "lat": glat, "generalised": True, "precision_km": round(cell * 111, 1)}
    return {"lon": round(lon, 6), "lat": round(lat, 6), "generalised": False, "precision_km": None}
