export type ProcessingStatus = "queued" | "processing" | "ready" | "failed";

export type ProcessingStage =
  | "queued"
  | "decode"
  | "transcribe"
  | "diarize"
  | "extract"
  | "complete";

export type TaskStatus = "open" | "in_progress" | "done";
export type DeadlineKind =
  | "date"
  | "relative"
  | "event"
  | "unspecified"
  | "conflicting";

export interface Health {
  status: "ok" | "degraded";
  models: { asr: boolean; diarization: boolean; extraction: boolean };
}

export interface MeetingListItem {
  id: string;
  title: string;
  started_at: string | null;
  created_at: string;
  status: ProcessingStatus;
}

export interface Speaker {
  id: string;
  label: string;
  display_name: string;
  identification: "unknown" | "suggested" | "confirmed";
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speaker_id: string | null;
  text: string;
  needs_review: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee_name: string | null;
  assignee_type: "person" | "department" | "unknown";
  assignee_speaker_id: string | null;
  deadline_text: string | null;
  deadline_kind: DeadlineKind;
  due_date: string | null;
  status: TaskStatus;
  is_overdue: boolean;
  evidence_segment_ids: string[];
  needs_review: boolean;
  review_reasons: string[];
  reviewed: boolean;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "assignee_name"
    | "assignee_type"
    | "assignee_speaker_id"
    | "due_date"
    | "status"
    | "reviewed"
  >
>;

export interface Meeting extends MeetingListItem {
  timezone: string;
  duration_seconds: number | null;
  stage: ProcessingStage;
  progress: number | null;
  error: { code: string; message: string } | null;
  speakers: Speaker[];
  segments: Segment[];
  summary: { overview: string; decisions: string[]; risks: string[] };
  tasks: Task[];
}
