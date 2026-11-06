export type Role = "admin" | "analyst" | "field_monitor" | "viewer";
export type Level = "low" | "medium" | "high";
export type VStatus = "pending" | "verified" | "rejected";

export interface User {
  id: number; email: string; full_name: string; role: Role; org_id: number;
  org?: { id: number; name: string; kind: string; country: string } | null;
  can_view_sensitive: boolean; is_active: boolean; last_login?: string | null;
}

export interface Area {
  id: number; name: string; designation: string; district: string; country: string;
  area_km2: number | null; description: string | null; boundary_source: string | null;
}

export interface Location { lon: number; lat: number; generalised: boolean; precision_km: number | null }

export interface Observation {
  id: number; client_uuid: string; area_id: number | null; area_name: string | null;
  species: string; common_name: string | null; evidence_type: string; count: number;
  adults: number | null; juveniles: number | null; infants: number | null;
  observed_at: string; location: Location | null; gps_accuracy_m: number | null; sensitive: boolean;
  id_confidence: number | null; notes: string | null; source: string; validation_status: VStatus;
  validation_note: string | null; validated_at: string | null; observer_id: number | null; org_id: number | null;
  media_count: number; created_at: string;
}

export interface Component {
  label: string; basis: "observed" | "modelled"; confidence: string; data_as_of: string | null;
  score: number | null; level: Level; drivers: string[]; metrics: Record<string, unknown>; caveat?: string;
}

export interface ForecastPoint { period: string; rate: number; lower: number; upper: number }
export interface SeriesPoint { period: string; start: string; effort_km: number; records: number; individuals: number; rate: number; pending: number; complete: boolean }

export interface Assessment {
  id: number; area_id: number; computed_at: string; model_version: string; data_as_of: string | null;
  overall_level: Level; components: Record<string, Component>;
  forecast: { points?: ForecastPoint[]; fitted?: { period: string; fitted: number }[]; series: SeriesPoint[]; method?: string; interval?: string; horizon?: string } | null;
}

export interface Alert {
  id: number; area_id: number; area_name: string | null; indicator: string; level: Level;
  status: "new" | "acknowledged" | "verifying" | "verified" | "dismissed" | "resolved";
  basis: string; title: string; description: string; recommended_action: string | null; score: number | null;
  confidence: string | null; model_version: string | null; data_as_of: string | null;
  evidence: { drivers?: string[]; metrics?: Record<string, unknown>; caveat?: string; history?: { at: string; from: string; to: string }[] } | null;
  assigned_to: number | null; reviewed_by: number | null; reviewed_at: string | null; review_notes: string | null;
  created_at: string; updated_at: string;
}

export interface Task {
  id: number; alert_id: number | null; area_id: number | null; title: string; description: string | null;
  assigned_to: number | null; assignee_name: string | null; area_name: string | null; created_by: number | null;
  due_date: string | null; status: "open" | "in_progress" | "done" | "cancelled"; outcome: string | null;
  created_at: string; completed_at: string | null;
}

export interface Meta {
  evidence_types: string[]; roles: Role[]; alert_levels: Level[]; alert_statuses: string[];
  task_statuses: string[]; pressure_kinds: string[]; indicators: Record<string, string>;
  model_version: string; generalisation_km: number;
}

export const INDICATOR_ORDER = [
  "population_concern", "habitat_pressure", "biodiversity_change", "ecosystem_condition", "food_security_vulnerability",
] as const;

export const INDICATOR_SHORT: Record<string, string> = {
  population_concern: "Population",
  habitat_pressure: "Habitat",
  biodiversity_change: "Biodiversity",
  ecosystem_condition: "Ecosystem",
  food_security_vulnerability: "Food security",
};
