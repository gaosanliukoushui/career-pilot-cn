export type ResumeStyleProfile = {
  schema_version: 2;
  theme: "soe-outcome" | "internet-engineering" | "research-academic";
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

export type ResumeContentStrategy = {
  id: ResumeStyleProfile["theme"];
  label: string;
  audience: string;
  principle: string;
  experience_formula: string[];
  technology_rule: string;
  outcome_definition: string;
  section_priority: string[];
  section_guidance: Record<string, { labels: string[]; guidance: string }>;
  avoid: string[];
};

export type ResumeStyleDefinition = {
  id: ResumeStyleProfile["theme"];
  content_strategy_id: ResumeStyleProfile["theme"];
  label: string;
  short_label: string;
  description: string;
  palette: { accent: string; accent_dark: string; divider: string; muted: string; ink: string; paper: string };
  heading_style: "rule" | "serif-rule" | "minimal";
  header_alignment: "left" | "center";
  defaults: Omit<ResumeStyleProfile, "schema_version" | "theme">;
  recommendation: { emphases: ResumeStyleProfile["emphasis"][]; summary: string; signals: string[] };
  preview: { subtitle: string; key_points: string[] };
  preview_html: string;
};

export type ResumeStyleCatalog = {
  schema_version: 2;
  styles: ResumeStyleDefinition[];
  content_strategies: {
    schema_version: 1;
    id: string;
    source_scope: "reference_layout_and_editorial_patterns_only";
    fact_boundary: string;
    common_rules: string[];
    strategies: ResumeContentStrategy[];
  };
  content_audit: {
    experience_fact_count: number;
    result_fact_count: number;
    result_coverage_proxy: number;
    inference_boundary: "portfolio_level_proxy_not_fact_rewrite";
    guidance: string[];
  };
  recommendation: {
    style_id: ResumeStyleProfile["theme"];
    reasons: string[];
    basis: "publishable_fact_distribution";
    fact_summary: { total: number; counts: Record<string, number> };
  };
};
