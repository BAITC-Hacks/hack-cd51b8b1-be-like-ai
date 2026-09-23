from datetime import date, datetime
from typing import Literal
from uuid import uuid4
from pydantic import BaseModel, ConfigDict, Field, model_validator


def new_id() -> str:
    return str(uuid4())


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ErrorInfo(StrictModel):
    code: str
    message: str


class Speaker(StrictModel):
    id: str = Field(default_factory=new_id)
    label: str
    display_name: str
    identification: Literal['unknown', 'suggested', 'confirmed'] = 'unknown'
    evidence_segment_ids: list[str] = Field(default_factory=list)


class Segment(StrictModel):
    id: str = Field(default_factory=new_id)
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    speaker_id: str | None = None
    text: str
    needs_review: bool = False

    @model_validator(mode='after')
    def ordered(self):
        if self.end < self.start:
            raise ValueError('Segment end precedes its start')
        return self


DeadlineKind = Literal['date', 'relative', 'event', 'unspecified', 'conflicting']
TaskStatus = Literal['open', 'in_progress', 'done']
AssigneeType = Literal['person', 'department', 'unknown']


class Task(StrictModel):
    id: str = Field(default_factory=new_id)
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default='', max_length=3000)
    assignee_name: str | None = Field(default=None, max_length=300)
    assignee_type: AssigneeType = 'unknown'
    assignee_speaker_id: str | None = None
    deadline_text: str | None = Field(default=None, max_length=500)
    deadline_kind: DeadlineKind = 'unspecified'
    due_date: date | None = None
    status: TaskStatus = 'open'
    is_overdue: bool = False
    evidence_segment_ids: list[str] = Field(default_factory=list)
    needs_review: bool = True
    review_reasons: list[str] = Field(default_factory=list)
    reviewed: bool = False


class Summary(StrictModel):
    overview: str = ''
    decisions: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


class Meeting(StrictModel):
    id: str = Field(default_factory=new_id)
    title: str = Field(min_length=1, max_length=300)
    started_at: datetime | None = None
    created_at: datetime
    timezone: str = 'Asia/Almaty'
    status: Literal['queued', 'processing', 'ready', 'failed'] = 'queued'
    stage: Literal['queued', 'decode', 'transcribe', 'diarize', 'extract', 'complete'] = 'queued'
    duration_seconds: float | None = None
    progress: float | None = None
    error: ErrorInfo | None = None
    speakers: list[Speaker] = Field(default_factory=list)
    segments: list[Segment] = Field(default_factory=list)
    summary: Summary = Field(default_factory=Summary)
    tasks: list[Task] = Field(default_factory=list)


class TaskPatch(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=3000)
    assignee_name: str | None = Field(default=None, max_length=300)
    assignee_type: AssigneeType | None = None
    assignee_speaker_id: str | None = None
    due_date: date | None = None
    status: TaskStatus | None = None
    reviewed: bool | None = None

    @model_validator(mode='after')
    def reject_null_required(self):
        for name in ('title', 'description', 'assignee_type', 'status', 'reviewed'):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f'{name} cannot be null')
        if self.title is not None and not self.title.strip():
            raise ValueError('Title cannot be blank')
        return self


class SpeakerPatch(StrictModel):
    display_name: str = Field(min_length=1, max_length=300)

    @model_validator(mode='after')
    def not_blank(self):
        self.display_name = self.display_name.strip()
        if not self.display_name:
            raise ValueError('Name cannot be blank')
        return self


class ExtractedTask(StrictModel):
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default='', max_length=3000)
    assignee_name: str | None = Field(default=None, max_length=300)
    assignee_type: AssigneeType = 'unknown'
    assignee_speaker_id: str | None = None
    deadline_text: str | None = Field(default=None, max_length=500)
    deadline_kind: DeadlineKind = 'unspecified'
    evidence_segment_ids: list[str] = Field(min_length=1, max_length=30)
    review_reasons: list[str] = Field(default_factory=list)


class SpeakerSuggestion(StrictModel):
    speaker_id: str
    display_name: str = Field(min_length=1, max_length=300)
    evidence_segment_ids: list[str] = Field(min_length=1, max_length=20)


class Extraction(StrictModel):
    summary: Summary
    tasks: list[ExtractedTask] = Field(max_length=100)
    speakers: list[SpeakerSuggestion] = Field(default_factory=list, max_length=30)


class SpeakerIdentification(StrictModel):
    speakers: list[SpeakerSuggestion] = Field(max_length=30)
