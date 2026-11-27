export type PollMode = "single" | "approval" | "rating" | "quiz";
export type PollPhase = "open" | "closed" | "published";

export interface ModeSummaryApproval {
  yes: number;
  no: number;
  abstain: number;
  approval_pct: number | null;
  passed: boolean | null;
}

export interface ModeSummaryRating {
  average: number | null;
}

export interface ModeSummaryQuiz {
  correct_count: number;
  correct_pct: number | null;
}

export type ModeSummary =
  | Record<string, never>
  | ModeSummaryApproval
  | ModeSummaryRating
  | ModeSummaryQuiz;

export interface PollItemHost {
  id: string;
  title: string;
  options: string[];
  phase: PollPhase;
  my_choice: number;
  deadline_at_ms?: number;
  remaining_ms?: number;
  counts: number[];
  total: number;
  mode: PollMode;
  correct_choice: number | null;
  mode_summary: ModeSummary;
}

export interface PollItemDevice {
  id: string;
  title: string;
  options: string[];
  phase: PollPhase;
  my_choice: number;
  deadline_at_ms?: number;
  remaining_ms?: number;
  counts?: number[];
  total?: number;
  batch?: {
    index: number;
    count: number;
    answered: number;
    next?: string;
    prev?: string;
  };
}

export interface DeviceSnapshot {
  v: 1;
  type: "state";
  poll: PollItemDevice | null;
  join_code?: string;
}

export interface DeviceStatus {
  id: string;
  online: boolean;
  answered: number;
  voted: boolean;
  alias: string;
}

export interface HostStateResponse {
  v: 1;
  type: "state";
  server_now_ms: number;
  poll: PollItemHost | null;
  batch?: {
    id: string;
    polls: PollItemHost[];
    shown_result: string | null;
  };
  latest_report: string | null;
  join_code: string;
  nonce?: string;
  max_devices: number;
  device_limit_max: number;
  addresses: string[];
  port: number;
  host_id: string;
  discovery_available: boolean;
  max_batch_polls: number;
  supports_append: boolean;
  supports_modes: boolean;
  supports_question_library: boolean;
  supports_history_delete: boolean;
  supports_open_join: boolean;
  supports_rotate_join_code: boolean;
  open_join_remaining_ms: number;
  open_join_until_ms: number | null;
  history_count: number;
  devices: DeviceStatus[];
  cloud_mode: true;
  readonly_stage: boolean;
  ws_url: string;
  stage_share_path?: string;
}

export interface ReportQuestion {
  id: string;
  title: string;
  options: string[];
  counts: number[];
  total: number;
  mode: PollMode;
  correct_choice: number | null;
  mode_summary: ModeSummary;
}

export interface PollReportSummary {
  cursor: number;
  id: string;
  title: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  question_count: number;
  participants: number;
  total_votes: number;
}

export interface PollReportDetail {
  id: string;
  title: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  question_count: number;
  participants: number;
  total_votes: number;
  questions: ReportQuestion[];
}

export interface LibraryQuestion {
  id: string;
  title: string;
  options: string[];
  mode: PollMode;
  correct_choice: number | null;
  revision: number;
}

export interface SocketAttachment {
  deviceId: string | null;
  viewedId: string | null;
  authed: boolean;
  connectedAtMs: number;
  recentMs: number[];
}

export interface ParsedQuestion {
  title: string;
  optionsJson: string;
  mode: PollMode;
  correctChoice: number | null;
}
