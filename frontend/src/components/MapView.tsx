import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "ol/ol.css";
import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import HeatmapLayer from "ol/layer/Heatmap";
import VectorSource from "ol/source/Vector";
import ClusterSource from "ol/source/Cluster";
import XYZ from "ol/source/XYZ";
import OSM from "ol/source/OSM";
import GeoJSON from "ol/format/GeoJSON";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { fromLonLat, toLonLat } from "ol/proj";
import { boundingExtent, createEmpty, extend as extendExtent } from "ol/extent";
import { Circle, Fill, RegularShape, Stroke, Style, Text } from "ol/style";
import { Attribution, MousePosition, ScaleLine, Zoom } from "ol/control";
import type { FeatureLike } from "ol/Feature";
import type { Coordinate } from "ol/coordinate";

export interface Pressure { id: number; kind: string; severity: number; lon: number; lat: number; observed_at: string; area_name: string | null; validation_status: string }

export type Basemap = "light" | "streets" | "satellite" | "terrain";
export type RecordDisplay = "clusters" | "points" | "heatmap";
export interface MapLayers { areas: boolean; chimps: boolean; wildlife: boolean; pressures: boolean; imagery?: boolean;
  cameras?: boolean; patrols?: boolean; conflicts?: boolean; forest?: boolean }
export interface FieldData {
  cameras?: { id: number; code: string; area_name: string | null; active_deployment: unknown; location: { lon: number; lat: number; generalised: boolean } | null }[] | null;
  patrols?: GeoJSON.FeatureCollection | null;
  conflicts?: { id: number; lon: number; lat: number; kind: string; species: string; community: string | null; occurred_at: string; status: string }[] | null;
  forest?: { id: number; lon: number; lat: number; date: string; confidence: string | null; area_name: string | null }[] | null;
}
/** Overlay colours, chosen to stay distinct from the chimp teal and pressure red. */
export const FIELD_COLORS = { cameras: "#5b4b8a", patrols: "#2563a8", conflicts: "#b8661a", forest: "#c0267a" };

export const BASEMAPS: Record<Basemap, { label: string; url: string; attribution: string; maxZoom: number }> = {
  // Esri Light Gray Canvas: clean, label-light, no API key required.
  // (CARTO raster tiles have required an API key since September 2026.)
  light: {
    label: "Light", maxZoom: 16,
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community",
  },
  streets: { label: "Streets", maxZoom: 19, url: "", attribution: "" },
  satellite: {
    label: "Satellite", maxZoom: 18,
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  },
  terrain: {
    label: "Terrain", maxZoom: 17,
    url: "https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, SRTM | © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)',
  },
};

export interface MapHandle {
  zoomToAll: () => void;
  zoomToArea: (id: number) => void;
  locate: () => Promise<void>;
}

interface Props {
  areas?: GeoJSON.FeatureCollection | null;
  observations?: GeoJSON.FeatureCollection | null;
  pressures?: Pressure[] | null;
  layers?: Partial<MapLayers>;
  basemap?: Basemap;
  display?: RecordDisplay;
  selectedAreaId?: number | null;
  onAreaClick?: (id: number) => void;
  focusAreaId?: number;
  showScale?: boolean;
  showCoordinates?: boolean;
  field?: FieldData;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const alpha = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const PAD = [48, 48, 48, 48];

const MapView = forwardRef<MapHandle, Props>(function MapView(
  { areas, observations, pressures, layers = {}, basemap = "light", display = "clusters", selectedAreaId, onAreaClick,
    focusAreaId, showScale = true, showCoordinates = false, field }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const areaSrc = useRef(new VectorSource());
  const obsSrc = useRef(new VectorSource());
  const pressSrc = useRef(new VectorSource());
  const youSrc = useRef(new VectorSource());
  const camSrc = useRef(new VectorSource());
  const patSrc = useRef(new VectorSource());
  const conSrc = useRef(new VectorSource());
  const forSrc = useRef(new VectorSource());
  const L = useRef<Record<string, TileLayer | VectorLayer | HeatmapLayer>>({});
  const [pop, setPop] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);
  const clickRef = useRef(onAreaClick);
  const fitRef = useRef<number[] | null>(null);
  const selRef = useRef<number | null | undefined>(selectedAreaId);
  clickRef.current = onAreaClick;
  selRef.current = selectedAreaId;

  useImperativeHandle(ref, () => ({
    zoomToAll: () => {
      const ext = areaSrc.current.getExtent();
      if (ext && mapRef.current && areaSrc.current.getFeatures().length) {
        fitRef.current = ext;
        mapRef.current.getView().fit(ext, { padding: PAD, maxZoom: 11, duration: 400 });
      }
    },
    zoomToArea: (id: number) => {
      const f = areaSrc.current.getFeatures().find((x) => Number(x.get("id")) === id);
      const ext = f?.getGeometry()?.getExtent();
      if (ext && mapRef.current) {
        fitRef.current = ext;  // keep this target if the panel layout resizes the map
        mapRef.current.getView().fit(ext, { padding: PAD, maxZoom: 12, duration: 400 });
      }
    },
    locate: () => new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("This device can't share its location")); return; }
      navigator.geolocation.getCurrentPosition((p) => {
        const c = fromLonLat([p.coords.longitude, p.coords.latitude]);
        youSrc.current.clear();
        youSrc.current.addFeature(new Feature({ geometry: new Point(c), you: true }));
        mapRef.current?.getView().animate({ center: c, zoom: 12, duration: 500 });
        resolve();
      }, () => reject(new Error("Location permission was denied")), { enableHighAccuracy: true, timeout: 15000 });
    }),
  }));

  useEffect(() => {
    if (!el.current) return;
    const levelColor = (lv?: string) => (lv === "high" ? css("--high") : lv === "medium" ? css("--medium") : lv === "low" ? css("--low") : css("--ink-3"));
    const areaStyle = (f: FeatureLike, res: number) => {
      const c = levelColor(f.get("risk_level"));
      const selected = selRef.current != null && Number(f.get("id")) === selRef.current;
      void res;
      return new Style({
        fill: new Fill({ color: alpha(c, selected ? 0.28 : 0.14) }),
        stroke: new Stroke({ color: c, width: selected ? 3.5 : 2 }),
      });
    };
    const labelStyle = (f: FeatureLike, res: number) => res > 900 ? undefined : new Style({
      text: new Text({
        text: String(f.get("name") ?? "").replace(/ (National Park|Forest Reserve)$/, ""), font: `650 12px ${css("--font")}`,
        fill: new Fill({ color: "#14281f" }), stroke: new Stroke({ color: "rgba(255,255,255,.95)", width: 4 }),
        overflow: true, offsetY: -2, padding: [2, 4, 2, 4],
      }),
    });
    const teal = css("--teal"), ink2 = css("--ink-2");
    const single = (f: FeatureLike) => {
      if (!String(f.get("species")).startsWith("Pan ")) {
        return new Style({ image: new Circle({ radius: 3.5, fill: new Fill({ color: ink2 }), stroke: new Stroke({ color: "#fff", width: 1 }) }) });
      }
      return f.get("generalised")
        ? new Style({ image: new RegularShape({ points: 4, radius: 7, angle: Math.PI / 4, fill: new Fill({ color: alpha(teal, 0.22) }), stroke: new Stroke({ color: teal, width: 1.5 }) }) })
        : new Style({ image: new Circle({ radius: 4.5, fill: new Fill({ color: teal }), stroke: new Stroke({ color: "#fff", width: 1.5 }) }) });
    };
    const clusterCache = new Map<number, Style>();
    const clusterStyle = (f: FeatureLike) => {
      const members = f.get("features") as Feature[];
      if (members.length === 1) return single(members[0]);
      const n = members.length;
      const key = n > 99 ? 100 : n;
      if (!clusterCache.has(key)) {
        const r = Math.min(26, 11 + Math.log2(n) * 3);
        clusterCache.set(key, new Style({
          image: new Circle({ radius: r, fill: new Fill({ color: alpha(teal, 0.88) }), stroke: new Stroke({ color: alpha("#ffffff", 0.95), width: 3 }) }),
          text: new Text({ text: n > 999 ? "999+" : String(n), font: `700 11.5px ${css("--font")}`, fill: new Fill({ color: "#fff" }) }),
        }));
      }
      return clusterCache.get(key)!;
    };
    const pressStyle = (f: FeatureLike) => new Style({
      image: new RegularShape({ points: 3, radius: 5 + Number(f.get("severity")), fill: new Fill({ color: css("--high") }), stroke: new Stroke({ color: "#fff", width: 1.5 }) }),
    });
    const youStyle = new Style({ image: new Circle({ radius: 7, fill: new Fill({ color: "#2b7de9" }), stroke: new Stroke({ color: "#fff", width: 3 }) }) });

    L.current.light = new TileLayer({ source: new XYZ({ url: BASEMAPS.light.url, attributions: BASEMAPS.light.attribution, maxZoom: 16 }) });
    L.current.lightLabels = new TileLayer({
      source: new XYZ({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", maxZoom: 16 }),
      zIndex: 0,
    });
    L.current.streets = new TileLayer({ source: new OSM(), visible: false });
    L.current.satellite = new TileLayer({ source: new XYZ({ url: BASEMAPS.satellite.url, attributions: BASEMAPS.satellite.attribution, maxZoom: 18 }), visible: false });
    L.current.terrain = new TileLayer({ source: new XYZ({ url: BASEMAPS.terrain.url, attributions: BASEMAPS.terrain.attribution, maxZoom: 17 }), visible: false });
    L.current.areas = new VectorLayer({ source: areaSrc.current, style: areaStyle, zIndex: 1 });
    L.current.labels = new VectorLayer({ source: areaSrc.current, style: labelStyle, declutter: true, zIndex: 6 });
    L.current.points = new VectorLayer({ source: obsSrc.current, style: single, zIndex: 2, visible: false });
    L.current.clusters = new VectorLayer({ source: new ClusterSource({ source: obsSrc.current, distance: 42, minDistance: 16 }), style: clusterStyle, zIndex: 2 });
    L.current.heat = new HeatmapLayer({
      source: obsSrc.current, blur: 22, radius: 12, zIndex: 2, visible: false,
      weight: (f) => Math.min(1, 0.25 + Number(f.get("count") || 1) * 0.1),
      gradient: ["rgba(30,107,117,0)", "#7fc4c0", "#2f9e8f", "#e9c46a", "#e76f51", "#b83246"],
    });
    L.current.press = new VectorLayer({ source: pressSrc.current, style: pressStyle, zIndex: 3 });
    L.current.you = new VectorLayer({ source: youSrc.current, style: youStyle, zIndex: 4 });
    const C = FIELD_COLORS;
    const camStyle = (f: FeatureLike) => new Style({ image: new RegularShape({ points: 4, radius: 6, angle: Math.PI / 4,
      fill: new Fill({ color: f.get("active_deployment") ? C.cameras : "#fff" }), stroke: new Stroke({ color: f.get("active_deployment") ? "#fff" : C.cameras, width: 2 }) }) });
    const patStyle = [new Style({ stroke: new Stroke({ color: "rgba(255,255,255,.85)", width: 4.5 }) }), new Style({ stroke: new Stroke({ color: C.patrols, width: 2, lineDash: [6, 4] }) })];
    const conStyle = (f: FeatureLike) => new Style({ image: new RegularShape({ points: 4, radius: 6.5, angle: 0,
      fill: new Fill({ color: f.get("status") === "closed" ? alpha(C.conflicts, 0.35) : C.conflicts }), stroke: new Stroke({ color: "#fff", width: 1.5 }) }) });
    const forStyle = (f: FeatureLike) => new Style({ image: new Circle({ radius: ["high", "highest"].includes(f.get("confidence")) ? 3.5 : 2.5, fill: new Fill({ color: C.forest }) }) });
    L.current.patrols = new VectorLayer({ source: patSrc.current, style: patStyle, zIndex: 2, visible: false });
    L.current.forest = new VectorLayer({ source: forSrc.current, style: forStyle, zIndex: 2, visible: false });
    L.current.cameras = new VectorLayer({ source: camSrc.current, style: camStyle, zIndex: 3, visible: false });
    L.current.conflicts = new VectorLayer({ source: conSrc.current, style: conStyle, zIndex: 3, visible: false });

    const controls = [new Zoom({ className: "ol-zoom cw-zoom" }), new Attribution({ collapsible: true, collapsed: true })];
    if (showScale) controls.push(new ScaleLine({ units: "metric", minWidth: 80, className: "cw-scale" }) as never);
    if (showCoordinates) {
      controls.push(new MousePosition({
        className: "cw-coords", placeholder: "Move over the map for coordinates",
        coordinateFormat: (c?: Coordinate) => {
          if (!c) return "";
          const [lon, lat] = toLonLat(c);
          return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
        },
      }) as never);
    }

    const map = new OLMap({
      target: el.current,
      layers: [L.current.light, L.current.lightLabels, L.current.streets, L.current.satellite, L.current.terrain, L.current.areas,
        L.current.patrols, L.current.forest, L.current.heat, L.current.points, L.current.clusters, L.current.press,
        L.current.cameras, L.current.conflicts, L.current.you, L.current.labels],
      view: new View({ center: fromLonLat([-11.8, 8.55]), zoom: 7.6, minZoom: 5, maxZoom: 18 }),
      controls,
    });

    map.on("pointermove", (e) => {
      if (e.dragging) return;
      const hit = map.forEachFeatureAtPixel(e.pixel, (ft, layer) => [ft, layer] as const, { hitTolerance: 4 });
      const tgt = map.getTargetElement();
      if (!hit) { setPop(null); if (tgt) tgt.style.cursor = ""; return; }
      const [f, layer] = hit;
      if (layer === L.current.labels) { setPop(null); return; }
      if (tgt) tgt.style.cursor = layer === L.current.areas || layer === L.current.clusters ? "pointer" : "";
      let p = f.getProperties();
      let html: React.ReactNode;
      if (layer === L.current.clusters) {
        const members = p.features as Feature[];
        if (members.length > 1) {
          const chimps = members.filter((m) => String(m.get("species")).startsWith("Pan ")).length;
          html = <><b>{members.length} records</b><div className="muted">{chimps} chimpanzee · {members.length - chimps} other wildlife</div><div className="muted">Click to zoom in</div></>;
          setPop({ x: e.pixel[0], y: e.pixel[1], html });
          return;
        }
        p = members[0].getProperties();
      }
      const day = (v: string) => new Date(v).toLocaleDateString("en-GB");
      const words = (v: unknown) => String(v).replace(/_/g, " ");
      if (layer === L.current.cameras) html = <><b>Camera station {p.code}</b><div className="muted">{p.active_deployment ? "Camera in the field" : "No camera deployed"} · {p.area_name ?? "Outside pilot areas"}</div>{p.generalised && <div className="muted">Position generalised</div>}</>;
      else if (layer === L.current.patrols) html = <><b>Patrol, {Number(p.distance_km).toFixed(1)} km</b><div className="muted">{day(p.started_at)} · {p.team || p.leader_name || "—"} · {words(p.purpose)}</div></>;
      else if (layer === L.current.conflicts) html = <><b>{words(p.kind)[0].toUpperCase() + words(p.kind).slice(1)}</b><div className="muted">{words(p.species)} · {p.community ?? "—"} · {day(p.occurred_at)}</div><div className="muted">Status: {p.status}</div></>;
      else if (layer === L.current.forest) html = <><b>Satellite forest alert</b><div className="muted">{day(p.date)} · {p.confidence ?? "—"} confidence</div><div className="muted">{p.area_name ?? ""}</div></>;
      else if (p.you) html = <b>Your location</b>;
      else if (p.kind) html = <><b>{String(p.kind)[0].toUpperCase() + String(p.kind).slice(1)} pressure</b><div className="muted">Severity {p.severity} of 3 · {new Date(p.observed_at).toLocaleDateString("en-GB")}</div><div className="muted">{p.area_name ?? "Outside pilot areas"} · {p.validation_status}</div></>;
      else if (p.species) html = <><b>{p.common_name || p.species}</b><div className="muted">{String(p.evidence_type).replace(/_/g, " ")} · {p.count} · {new Date(p.observed_at).toLocaleDateString("en-GB")}</div>{p.generalised && <div className="muted">Location generalised to ~{p.precision_km} km</div>}</>;
      else html = <><b>{p.name}</b><div className="muted">{p.designation} · {p.district}</div><div>Overall concern: {p.risk_level ?? "not assessed"}</div><div className="muted">Click for details</div></>;
      setPop({ x: e.pixel[0], y: e.pixel[1], html });
    });
    map.on("click", (e) => {
      const hit = map.forEachFeatureAtPixel(e.pixel, (ft, layer) => [ft, layer] as const, { hitTolerance: 4 });
      if (!hit) return;
      const [f, layer] = hit;
      if (layer === L.current.clusters) {
        const members = f.get("features") as Feature[];
        if (members.length > 1) {
          const ext = createEmpty();
          members.forEach((m) => extendExtent(ext, boundingExtent([(m.getGeometry() as Point).getCoordinates()])));
          map.getView().fit(ext, { padding: [80, 80, 80, 80], maxZoom: 14, duration: 400 });
          return;
        }
      }
      const area = map.forEachFeatureAtPixel(e.pixel, (ft) => ft, { layerFilter: (l) => l === L.current.areas });
      if (area && clickRef.current) clickRef.current(Number(area.get("id")));
    });
    mapRef.current = map;

    let userMoved = false;
    map.on("pointerdrag", () => { userMoved = true; });
    el.current.addEventListener("wheel", () => { userMoved = true; }, { passive: true });
    const ro = new ResizeObserver(() => {
      map.updateSize();
      if (!userMoved && fitRef.current) map.getView().fit(fitRef.current, { padding: PAD, maxZoom: 12 });
    });
    ro.observe(el.current);
    return () => { ro.disconnect(); map.setTarget(undefined); };
  }, [showScale, showCoordinates]);

  useEffect(() => {
    const s = areaSrc.current;
    s.clear();
    if (!areas) return;
    s.addFeatures(new GeoJSON().readFeatures(areas, { featureProjection: "EPSG:3857" }));
    const map = mapRef.current;
    if (!map || !s.getFeatures().length) return;
    const target = focusAreaId ? s.getFeatures().find((f) => Number(f.get("id")) === focusAreaId) : null;
    const extent = target?.getGeometry()?.getExtent() ?? s.getExtent();
    if (!extent) return;
    fitRef.current = extent;
    map.getView().fit(extent, { padding: PAD, maxZoom: 11 });
  }, [areas, focusAreaId]);

  // Observations, filtered by the chimp / wildlife toggles
  useEffect(() => {
    const s = obsSrc.current;
    s.clear();
    if (!observations) return;
    const showChimp = layers.chimps !== false, showWild = layers.wildlife !== false;
    const feats = new GeoJSON().readFeatures(observations, { featureProjection: "EPSG:3857" })
      .filter((f) => (String(f.get("species")).startsWith("Pan ") ? showChimp : showWild));
    s.addFeatures(feats);
  }, [observations, layers.chimps, layers.wildlife]);

  useEffect(() => {
    const s = pressSrc.current;
    s.clear();
    (pressures || []).forEach((p) => s.addFeature(new Feature({ geometry: new Point(fromLonLat([p.lon, p.lat])), ...p })));
  }, [pressures]);

  useEffect(() => {
    camSrc.current.clear();
    (field?.cameras || []).forEach((c) => c.location && camSrc.current.addFeature(new Feature({ geometry: new Point(fromLonLat([c.location.lon, c.location.lat])), ...c, generalised: c.location.generalised })));
  }, [field?.cameras]);
  useEffect(() => {
    patSrc.current.clear();
    if (field?.patrols) patSrc.current.addFeatures(new GeoJSON().readFeatures(field.patrols, { featureProjection: "EPSG:3857" }));
  }, [field?.patrols]);
  useEffect(() => {
    conSrc.current.clear();
    (field?.conflicts || []).forEach((c) => conSrc.current.addFeature(new Feature({ geometry: new Point(fromLonLat([c.lon, c.lat])), ...c })));
  }, [field?.conflicts]);
  useEffect(() => {
    forSrc.current.clear();
    (field?.forest || []).forEach((c) => forSrc.current.addFeature(new Feature({ geometry: new Point(fromLonLat([c.lon, c.lat])), ...c })));
  }, [field?.forest]);
  useEffect(() => {
    L.current.cameras?.setVisible(!!layers.cameras);
    L.current.patrols?.setVisible(!!layers.patrols);
    L.current.conflicts?.setVisible(!!layers.conflicts);
    L.current.forest?.setVisible(!!layers.forest);
  }, [layers.cameras, layers.patrols, layers.conflicts, layers.forest]);

  useEffect(() => {
    const bm: Basemap = layers.imagery ? "satellite" : basemap;
    (["light", "streets", "satellite", "terrain"] as Basemap[]).forEach((k) => L.current[k]?.setVisible(k === bm));
    L.current.lightLabels?.setVisible(bm === "light");
    L.current.areas?.setVisible(layers.areas !== false);
    L.current.labels?.setVisible(layers.areas !== false);
    L.current.press?.setVisible(layers.pressures !== false);
    L.current.clusters?.setVisible(display === "clusters");
    L.current.points?.setVisible(display === "points");
    L.current.heat?.setVisible(display === "heatmap");
  }, [layers.areas, layers.pressures, layers.imagery, basemap, display]);

  useEffect(() => { (L.current.areas as VectorLayer | undefined)?.changed(); }, [selectedAreaId]);

  return (
    <>
      <div ref={el} className="map" />
      {pop && <div className="map-pop" style={{ left: pop.x, top: pop.y }}>{pop.html}</div>}
    </>
  );
});

export default MapView;

export function MapLegend({ generalisedKm, compact = false, extra }: { generalisedKm?: number; compact?: boolean; extra?: Partial<MapLayers> }) {
  const C = FIELD_COLORS;
  return (
    <div className={`map-legend ${compact ? "compact" : ""}`}>
      <div className="lg-title">Overall concern</div>
      <div className="lg-row">
        <span><i className="sw" style={{ borderColor: "var(--high)", background: "var(--high-soft)" }} />High</span>
        <span><i className="sw" style={{ borderColor: "var(--medium)", background: "var(--medium-soft)" }} />Medium</span>
        <span><i className="sw" style={{ borderColor: "var(--low)", background: "var(--low-soft)" }} />Low</span>
      </div>
      <div><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="var(--teal)" /></svg>Chimpanzee record</div>
      <div><svg width="12" height="12"><rect x="2" y="2" width="8" height="8" transform="rotate(45 6 6)" fill="none" stroke="var(--teal)" strokeWidth="1.5" /></svg>Generalised to ~{generalisedKm ?? 11} km</div>
      <div><svg width="12" height="12"><path d="M6 1l5 10H1z" fill="var(--high)" /></svg>Human pressure report</div>
      {extra?.cameras && <div><svg width="12" height="12"><rect x="2.5" y="2.5" width="7" height="7" transform="rotate(45 6 6)" fill={C.cameras} /></svg>Camera station (hollow: no camera)</div>}
      {extra?.patrols && <div><svg width="12" height="12"><path d="M0 6h12" stroke={C.patrols} strokeWidth="2" strokeDasharray="4 2" /></svg>Patrol track</div>}
      {extra?.conflicts && <div><svg width="12" height="12"><rect x="2" y="2" width="8" height="8" fill={C.conflicts} /></svg>Wildlife conflict incident</div>}
      {extra?.forest && <div><svg width="12" height="12"><circle cx="6" cy="6" r="3" fill={C.forest} /></svg>Satellite forest alert</div>}
    </div>
  );
}
