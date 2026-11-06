import { useEffect, useRef, useState } from "react";
import "ol/ol.css";
import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import GeoJSON from "ol/format/GeoJSON";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { fromLonLat } from "ol/proj";
import { Circle, Fill, RegularShape, Stroke, Style, Text } from "ol/style";
import { defaults as defaultControls } from "ol/control/defaults";
import type { FeatureLike } from "ol/Feature";

export interface Pressure { id: number; kind: string; severity: number; lon: number; lat: number; observed_at: string; area_name: string | null; validation_status: string }

export interface MapLayers { areas: boolean; chimps: boolean; wildlife: boolean; pressures: boolean; imagery: boolean }

interface Props {
  areas?: GeoJSON.FeatureCollection | null;
  observations?: GeoJSON.FeatureCollection | null;
  pressures?: Pressure[] | null;
  layers?: Partial<MapLayers>;
  onAreaClick?: (id: number) => void;
  focusAreaId?: number;
  height?: string;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const alpha = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export default function MapView({ areas, observations, pressures, layers = {}, onAreaClick, focusAreaId }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap | null>(null);
  const srcs = useRef({ areas: new VectorSource(), obs: new VectorSource(), press: new VectorSource() });
  const lyr = useRef<Record<string, TileLayer | VectorLayer>>({});
  const [pop, setPop] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);
  const clickRef = useRef(onAreaClick);
  const fitRef = useRef<number[] | null>(null);
  clickRef.current = onAreaClick;

  useEffect(() => {
    if (!el.current) return;
    const levelColor = (lv?: string) => (lv === "high" ? css("--high") : lv === "medium" ? css("--medium") : lv === "low" ? css("--low") : css("--ink-3"));
    const areaStyle = (f: FeatureLike) => {
      const c = levelColor(f.get("risk_level"));
      return new Style({
        fill: new Fill({ color: alpha(c, 0.16) }),
        stroke: new Stroke({ color: c, width: 2 }),
        text: new Text({
          text: String(f.get("name") ?? "").replace(/ (National Park|Forest Reserve)$/, ""), font: `600 12px ${css("--font")}`,
          fill: new Fill({ color: css("--ink") }), stroke: new Stroke({ color: css("--surface"), width: 3 }), overflow: true,
        }),
      });
    };
    const chimp = new Style({ image: new Circle({ radius: 4, fill: new Fill({ color: css("--teal") }), stroke: new Stroke({ color: css("--surface"), width: 1.5 }) }) });
    const chimpGen = new Style({ image: new RegularShape({ points: 4, radius: 7, angle: Math.PI / 4, fill: new Fill({ color: alpha(css("--teal"), 0.25) }), stroke: new Stroke({ color: css("--teal"), width: 1.5 }) }) });
    const wildlife = new Style({ image: new Circle({ radius: 3, fill: new Fill({ color: css("--ink-2") }), stroke: new Stroke({ color: css("--surface"), width: 1 }) }) });
    const obsStyle = (f: FeatureLike) => (String(f.get("species")).startsWith("Pan ") ? (f.get("generalised") ? chimpGen : chimp) : wildlife);
    const pressStyle = (f: FeatureLike) => new Style({
      image: new RegularShape({ points: 3, radius: 5 + f.get("severity"), fill: new Fill({ color: css("--high") }), stroke: new Stroke({ color: css("--surface"), width: 1.5 }) }),
    });

    lyr.current.osm = new TileLayer({ source: new OSM(), className: "ol-osm" });
    lyr.current.imagery = new TileLayer({
      source: new XYZ({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attributions: "Imagery © Esri", maxZoom: 18 }),
      visible: false,
    });
    lyr.current.areas = new VectorLayer({ source: srcs.current.areas, style: areaStyle, declutter: true });
    lyr.current.areas.setZIndex(1);
    lyr.current.obs = new VectorLayer({ source: srcs.current.obs, style: obsStyle });
    lyr.current.obs.setZIndex(2);
    lyr.current.press = new VectorLayer({ source: srcs.current.press, style: pressStyle });
    lyr.current.press.setZIndex(3);

    const map = new OLMap({
      target: el.current,
      layers: [lyr.current.osm, lyr.current.imagery, lyr.current.areas, lyr.current.obs, lyr.current.press],
      view: new View({ center: fromLonLat([-11.8, 8.55]), zoom: 7.6, minZoom: 5, maxZoom: 17 }),
      controls: defaultControls({ rotate: false, attributionOptions: { collapsible: true } }),
    });
    map.on("pointermove", (e) => {
      if (e.dragging) return;
      const f = map.forEachFeatureAtPixel(e.pixel, (ft) => ft, { hitTolerance: 4 }) as Feature | undefined;
      const tgt = map.getTargetElement();
      if (tgt) tgt.style.cursor = f && f.get("risk_level") !== undefined ? "pointer" : "";
      if (!f) { setPop(null); return; }
      const p = f.getProperties();
      let html: React.ReactNode;
      if (p.kind) html = <><b>{p.kind[0].toUpperCase() + p.kind.slice(1)} pressure</b><div className="muted">Severity {p.severity} · {new Date(p.observed_at).toLocaleDateString("en-GB")}</div><div className="muted">{p.validation_status}</div></>;
      else if (p.species) html = <><b>{p.common_name || p.species}</b><div className="muted">{p.evidence_type.replace(/_/g, " ")} · {p.count} · {new Date(p.observed_at).toLocaleDateString("en-GB")}</div>{p.generalised && <div className="muted">Location generalised to ~{p.precision_km} km</div>}</>;
      else html = <><b>{p.name}</b><div className="muted">{p.designation} · {p.district}</div><div>Overall concern: {p.risk_level ?? "not assessed"}</div></>;
      setPop({ x: e.pixel[0], y: e.pixel[1], html });
    });
    map.on("click", (e) => {
      const f = map.forEachFeatureAtPixel(e.pixel, (ft) => ft, { layerFilter: (l) => l === lyr.current.areas }) as Feature | undefined;
      if (f && clickRef.current) clickRef.current(Number(f.get("id")));
    });
    mapRef.current = map;
    // Re-fit to the data when the panel resizes, until the user pans or zooms themselves.
    let userMoved = false;
    map.on("pointerdrag", () => { userMoved = true; });
    el.current.addEventListener("wheel", () => { userMoved = true; }, { passive: true });
    const ro = new ResizeObserver(() => {
      map.updateSize();
      const ext = fitRef.current;
      if (!userMoved && ext) map.getView().fit(ext, { padding: [40, 40, 40, 40], maxZoom: 11 });
    });
    ro.observe(el.current);
    return () => { ro.disconnect(); map.setTarget(undefined); };
  }, []);

  useEffect(() => {
    const s = srcs.current.areas;
    s.clear();
    if (!areas) return;
    s.addFeatures(new GeoJSON().readFeatures(areas, { featureProjection: "EPSG:3857" }));
    const map = mapRef.current;
    if (!map || !s.getFeatures().length) return;
    const target = focusAreaId ? s.getFeatures().find((f) => f.get("id") === focusAreaId) : null;
    const extent = target?.getGeometry()?.getExtent() ?? s.getExtent();
    if (!extent) return;
    fitRef.current = extent;
    map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 11 });
  }, [areas, focusAreaId]);

  useEffect(() => {
    const s = srcs.current.obs;
    s.clear();
    if (observations) s.addFeatures(new GeoJSON().readFeatures(observations, { featureProjection: "EPSG:3857" }));
  }, [observations]);

  useEffect(() => {
    const s = srcs.current.press;
    s.clear();
    (pressures || []).forEach((p) => {
      const f = new Feature({ geometry: new Point(fromLonLat([p.lon, p.lat])), ...p });
      s.addFeature(f);
    });
  }, [pressures]);

  useEffect(() => {
    const L = lyr.current;
    L.areas?.setVisible(layers.areas !== false);
    L.press?.setVisible(layers.pressures !== false);
    L.imagery?.setVisible(!!layers.imagery);
    L.osm?.setVisible(!layers.imagery);
    const showChimp = layers.chimps !== false, showWild = layers.wildlife !== false;
    srcs.current.obs.getFeatures().forEach((f) => {
      const isChimp = String(f.get("species")).startsWith("Pan ");
      f.setStyle((isChimp ? showChimp : showWild) ? undefined : new Style({}));
    });
  }, [layers, observations]);

  return (
    <>
      <div ref={el} className="map" />
      {pop && <div className="map-pop" style={{ left: pop.x, top: pop.y }}>{pop.html}</div>}
    </>
  );
}

export function MapLegend({ generalisedKm }: { generalisedKm?: number }) {
  return (
    <div className="map-legend">
      <div><span className="sw" style={{ borderColor: "var(--high)", background: "var(--high-soft)" }} />High overall concern</div>
      <div><span className="sw" style={{ borderColor: "var(--medium)", background: "var(--medium-soft)" }} />Medium overall concern</div>
      <div><span className="sw" style={{ borderColor: "var(--low)", background: "var(--low-soft)" }} />Low overall concern</div>
      <div><svg width="12" height="12" style={{ marginRight: 6, verticalAlign: -2 }}><circle cx="6" cy="6" r="4" fill="var(--teal)" /></svg>Chimpanzee record</div>
      <div><svg width="12" height="12" style={{ marginRight: 6, verticalAlign: -2 }}><rect x="2" y="2" width="8" height="8" transform="rotate(45 6 6)" fill="none" stroke="var(--teal)" strokeWidth="1.5" /></svg>Generalised to ~{generalisedKm ?? 11} km</div>
      <div><svg width="12" height="12" style={{ marginRight: 6, verticalAlign: -2 }}><path d="M6 1l5 10H1z" fill="var(--high)" /></svg>Human pressure report</div>
    </div>
  );
}
