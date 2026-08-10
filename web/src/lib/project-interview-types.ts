export type ProjectInterviewProject = {
  id: string;
  name: string;
  summary: string;
  fact_count: number;
  fact_ids: string[];
};

export type ProjectInterviewSource = {
  id: string;
  kind: "verified_export";
  label: string;
  variant_id: string;
  template: string;
  target_job_title: string | null;
  generated_at: string;
  projects: ProjectInterviewProject[];
};

export type ProjectInterviewCatalog = {
  schema_version: 1;
  default_source_id: string | null;
  sources: ProjectInterviewSource[];
};

export type FactGroundedAnswer = {
  headline: string;
  source_fact_ids: string[];
  unknowns: string[];
};

export type ProjectInterviewQuestion = {
  id: string;
  category: "overview" | "ownership" | "architecture" | "mechanism" | "tradeoff" | "reliability";
  depth: "foundation" | "deep" | "pressure";
  question: string;
  intent: string;
  scoring_points: string[];
  reference_answer: FactGroundedAnswer & { points: string[] };
  follow_ups: string[];
};

export type ProjectInterviewPack = {
  schema_version: 1;
  phase: "pack";
  project_id: string;
  target_role: string;
  analysis: {
    positioning: string;
    interviewer_focus: string[];
    claim_boundaries: string[];
    preparation_priorities: string[];
    source_fact_ids: string[];
  };
  opening_answer: FactGroundedAnswer & { answer: string };
  questions: ProjectInterviewQuestion[];
};

export type ProjectInterviewReview = {
  schema_version: 1;
  phase: "feedback";
  project_id: string;
  question: string;
  status: "strong" | "solid" | "gap";
  score: number;
  dimension_scores: {
    structure: number;
    ownership: number;
    technical_depth: number;
    evidence: number;
    boundary: number;
  };
  landed: string[];
  sharpen: Array<{ issue: string; repair: string }>;
  unsupported_claims: Array<{ claim: string; reason: string }>;
  stronger_version: FactGroundedAnswer & { answer: string };
  follow_up_question: string;
};
