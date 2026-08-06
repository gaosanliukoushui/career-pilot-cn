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
  confirmation_status: "pending" | "confirmed" | "rejected";
};

export type JobPosting = {
  schema_version: 1;
  id: string;
  source: {
    kind: "pasted_text" | "public_url" | "official_url" | "pdf" | "docx";
    ref?: string;
    file_sha256?: string;
    final_url?: string;
    redirect_chain?: string[];
    fetched_at?: string;
    page_title?: string;
    capture_method?: "browser" | "http";
    capture_provider?: string;
    official?: boolean;
    official_basis?: "unconfirmed" | "user_confirmed" | "employer_domain" | "official_platform";
    official_evidence?: string;
  };
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
  confirmation: { status: "pending" | "confirmed"; confirmed_at: string | null; structure_sha256: string | null };
};

export type CampaignConstraint = {
  id: string;
  kind: "max_applications" | "mutually_exclusive";
  value: unknown;
  confirmation_status: "pending" | "confirmed" | "rejected";
  source_quote: string;
};

export type CampaignRankingEntry = {
  rank: number;
  job_id: string;
  title: string;
  eligibility: EligibilityResult;
  recommendation: Recommendation;
  fit_score: number;
  fact_coverage: number;
  gap_count: number;
  hard_rule_results: MatchReport["eligibility"]["rule_results"];
  evidence_fact_ids: string[];
  gaps: string[];
  unknowns: string[];
};

export type Campaign = {
  schema_version: 1;
  id: string;
  name: string;
  employer: string;
  recruitment_batch: string;
  deadline: string | null;
  constraints: CampaignConstraint[];
  jobs: Array<{ job_id: string; content_sha256: string; source_ref: string; status: "included" | "excluded"; exclusion_reason: string | null; added_at: string }>;
  ranking: { status: "pending" | "ready"; generated_at: string | null; source_sha256: string | null; profile_sha256: string | null; entries: CampaignRankingEntry[] };
  selection: { status: "pending" | "confirmed"; job_ids: string[]; confirmed_at: string | null; reason: string | null; ranking_sha256: string | null };
  audit_events: Array<{ type: string; recorded_at: string; details: Record<string, unknown> }>;
  created_at: string;
  updated_at: string;
};

export type ResumeStyleProfile = {
  schema_version: 2;
  theme: "soe-blue-standard" | "soe-navy-dense" | "soe-red-academic" | "soe-research-formal" | "technical-minimal";
  density: "balanced" | "full";
  page_budget: 1 | 2;
  emphasis: "general" | "technical" | "research" | "campus";
  font_family: "Microsoft YaHei" | "Noto Sans CJK SC" | "SimSun";
  font_size_pt: number;
  page_margin_cm: number;
  section_order: string[];
  project_bullet_limit: number;
  photo: { enabled: boolean; crop: "contain" | "center-3x4"; width_cm: number; height_cm: number };
};

export type ResumeStyleDefinition = {
  id: ResumeStyleProfile["theme"];
  label: string;
  short_label: string;
  description: string;
  palette: { accent: string; accent_dark: string; divider: string; muted: string; ink: string; paper: string };
  heading_style: "rule" | "heavy-rule" | "serif-rule" | "bar-rule" | "minimal";
  header_alignment: "left" | "center";
  defaults: Omit<ResumeStyleProfile, "schema_version" | "theme">;
  recommendation: { emphases: ResumeStyleProfile["emphasis"][]; summary: string; signals: string[] };
  preview: { subtitle: string; key_points: string[] };
  preview_html: string;
};

export type ResumeStyleCatalog = {
  schema_version: 1;
  styles: ResumeStyleDefinition[];
  editorial_policy: {
    schema_version: 1;
    id: string;
    label: string;
    source_scope: "reference_layout_and_editorial_patterns_only";
    fact_boundary: string;
    sections: Record<string, { label: string; pattern: string[]; avoid: string[] }>;
    transformation_rules: string[];
  };
  recommendation: {
    style_id: ResumeStyleProfile["theme"];
    reasons: string[];
    basis: "publishable_fact_distribution";
    fact_summary: { total: number; counts: Record<string, number> };
  };
};

export type ResumeArtifactManifestV2 = {
  schema_version: 2;
  campaign_id: string;
  job_id: string;
  target_job_title: string;
  output: string;
  content_sha256: string;
  format: "md" | "html" | "docx" | "pdf";
  qa: { fact_traceability: true; semantic_match: true; page_count: number | null; page_budget: number; text_layer: string; render_status: string };
};

export type RuntimeCapabilityReport = {
  schema_version: 1;
  playwright_cli: { available: boolean; launchable: boolean; error: string | null };
  project_browser_mcp_config: { configured: boolean; files: string[] };
  external_runtimes: Record<"codex_browser" | "chrome" | "edge", { declared: boolean; [key: string]: unknown }>;
  active_import_mode: "codex_browser_capture" | "batch_url" | "text_or_file";
  fallback_order: Array<"codex_browser_capture" | "batch_url" | "text_or_file">;
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
  official_url?: string | null;
  pre_submission_checklist?: Array<{ id: string; label: string; status: "ready" | "missing" | "manual_required" }>;
  fields: Array<{
    id: string;
    label: string;
    category: string;
    required: boolean;
    sensitivity: "public" | "personal" | "sensitive" | "restricted";
    manual_required: boolean;
    source_fact_ids: string[];
    max_length: number | null;
    definition_source: "default" | "job_posting" | "application_form";
    source_quote: string;
    confirmation_status: "pending" | "confirmed" | "manual_required";
    draft?: unknown;
  }>;
  materials: Array<{
    id: string;
    label: string;
    required: boolean;
    status: "ready" | "missing" | "manual_required";
    evidence_ids: string[];
    manual_required: boolean;
    definition_source: "default" | "job_posting" | "application_form";
    source_quote: string;
  }>;
  events: Array<{ stage: string; canonical_status: string; recorded_at: string; note: string }>;
};
