export type EligibilityResult = "eligible" | "ineligible" | "unknown";
export type Recommendation = "apply" | "consider" | "do_not_apply" | "need_more_info";

export type JobRule = {
  id: string;
  field: string;
  operator: string;
  expected: unknown;
  severity: "hard" | "soft";
  explicit: boolean;
  source_quote: string;
  confidence: number;
};

export type JobPosting = {
  schema_version: 1;
  id: string;
  source: { kind: "pasted_text" | "official_url" | "pdf" | "docx"; ref?: string; file_sha256?: string };
  captured_at: string;
  content_sha256: string;
  employer: { name: string; type: string };
  title: string;
  job_code?: string;
  recruitment: { track: string; cohort?: number; deadline?: string };
  locations: string[];
  raw_text: string;
  rules: JobRule[];
  posting_status: "unknown" | "active" | "closed" | "expired";
};

export type FitDimension = {
  id: "role_major" | "evidence" | "career_direction" | "mobility" | "development" | "source_reliability";
  score: number;
  weight?: number;
  candidate_fact_ids: string[];
  rationale: string;
};

export type MatchReport = {
  id: string;
  job_id: string;
  eligibility: {
    result: EligibilityResult;
    rule_results: Array<{
      rule_id: string;
      result: "satisfied" | "failed" | "unknown";
      candidate_fact_ids: string[];
      reason: string;
      source_quote: string;
    }>;
  };
  fit: { score: number; dimensions: Required<FitDimension>[] };
  recommendation: Recommendation;
  strengths: string[];
  gaps: string[];
  override: { reason: string; recorded_at: string } | null;
  report_path: string;
};

export type CareerPilotApplication = {
  id: string;
  job_id: string;
  tracker_num: number;
  current_stage: string;
  canonical_status: string;
  deadline: string | null;
  fields: Array<{
    id: string;
    label: string;
    category: string;
    required: boolean;
    sensitivity: "public" | "personal" | "sensitive" | "restricted";
    manual_required: boolean;
    source_fact_ids: string[];
    max_length: number | null;
    draft?: unknown;
  }>;
  materials: Array<{
    id: string;
    label: string;
    status: "ready" | "missing" | "manual_required";
    evidence_ids: string[];
    manual_required: boolean;
  }>;
  events: Array<{ stage: string; canonical_status: string; recorded_at: string; note: string }>;
};

