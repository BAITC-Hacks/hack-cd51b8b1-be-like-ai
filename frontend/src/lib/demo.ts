import type {
  Health,
  Meeting,
  MeetingListItem,
  Task,
  TaskPatch,
} from "../types";
import { ApiError } from "./api";

// Deliberately fictional, anonymized material. There is no associated recording.
export const DEMO_MEETING_ID = "9a01b894-63ab-48f3-bff8-395de189a330";
const speakerId = (n: number) =>
  `a113c355-994f-4429-a1b2-${String(n).padStart(12, "0")}`;
const segmentId = (n: number) =>
  `b223c355-994f-4429-a1b2-${String(n).padStart(12, "0")}`;
const taskId = (n: number) =>
  `c333c355-994f-4429-a1b2-${String(n).padStart(12, "0")}`;
const STORAGE_KEY = "meeting-assistant:demo:v1";
const RELATIVE_REASON =
  "Дата совещания неизвестна: относительный срок нельзя перевести в календарную дату.";
const CONFLICT_REASON =
  "В разговоре названы две даты; окончательный срок не подтверждён.";
const EVENT_REASON = "Срок зависит от события, дата которого не определена.";
const ASSIGNEE_REASON = "Ответственный не назван. Назначьте исполнителя.";

export const demoMeeting: Meeting = {
  id: DEMO_MEETING_ID,
  title: "Пилот городского сервиса · рабочая встреча",
  started_at: null,
  created_at: "2026-09-23T09:30:00+05:00",
  timezone: "Asia/Almaty",
  duration_seconds: null,
  status: "ready",
  stage: "complete",
  progress: null,
  error: null,
  speakers: [
    {
      id: speakerId(1),
      label: "SPEAKER_00",
      display_name: "Спикер 1",
      identification: "unknown",
    },
    {
      id: speakerId(2),
      label: "SPEAKER_01",
      display_name: "Спикер 2",
      identification: "unknown",
    },
    {
      id: speakerId(3),
      label: "SPEAKER_02",
      display_name: "Спикер 3",
      identification: "unknown",
    },
  ],
  segments: [
    {
      id: segmentId(1),
      start: 0,
      end: 22,
      speaker_id: speakerId(1),
      text: "Коллеги, обсудим пилот городского сервиса. Для первого запуска берём только обращения о состоянии дворов и освещении. Функцию оплаты переносим на следующий этап.",
      needs_review: false,
    },
    {
      id: segmentId(2),
      start: 24,
      end: 45,
      speaker_id: speakerId(2),
      text: "Пилотты екі ауданда бастаймыз. Тұрғындарға арналған нұсқаулық қазақ және орыс тілдерінде болуы керек. Алдымен өтініш беру жолын тексерейік.",
      needs_review: false,
    },
    {
      id: segmentId(3),
      start: 47,
      end: 66,
      speaker_id: speakerId(1),
      text: "Согласовано: два района и два языка. Спикер 2, подготовьте двуязычную инструкцию к следующей пятнице. Включите пример обращения и способ проверить его статус.",
      needs_review: true,
    },
    {
      id: segmentId(4),
      start: 68,
      end: 83,
      speaker_id: speakerId(2),
      text: "Да, беру инструкцию. Русскую и казахскую версии проверим вместе с редактором. Точную календарную дату нужно отдельно подтвердить.",
      needs_review: true,
    },
    {
      id: segmentId(5),
      start: 86,
      end: 112,
      speaker_id: speakerId(3),
      text: "Для запуска нужен текст уведомления об обработке персональных данных. Отдел правового сопровождения подготовит его до 25 сентября 2026 года. Представителей отдела сейчас нет, после встречи согласуем с ними поручение.",
      needs_review: false,
    },
    {
      id: segmentId(6),
      start: 115,
      end: 133,
      speaker_id: speakerId(1),
      text: "Правовое сопровождение указываем исполнителем, а согласование с отделом остаётся риском. Не будем записывать это поручение на того, кто его озвучил.",
      needs_review: false,
    },
    {
      id: segmentId(7),
      start: 136,
      end: 158,
      speaker_id: speakerId(3),
      text: "Я подготовлю сценарии проверки: новая заявка, дубликат, изменение статуса и недоступность сервиса. Завершу до 26 сентября 2026 года, сейчас уже работаю над списком.",
      needs_review: false,
    },
    {
      id: segmentId(8),
      start: 160,
      end: 180,
      speaker_id: speakerId(1),
      text: "Отчёт о доступности нужно собрать до 25 сентября 2026 года. Или давайте перенесём на 28 сентября, чтобы включить выходные. Окончательную дату пока не фиксируем. Кто возьмёт отчёт, решим отдельно.",
      needs_review: true,
    },
    {
      id: segmentId(9),
      start: 183,
      end: 205,
      speaker_id: speakerId(2),
      text: "Ещё нужен короткий показ для операторов. Его организует координатор пилота, он не участвует в этой встрече. Проведём показ после согласования инструкции, конкретной даты пока нет.",
      needs_review: true,
    },
    {
      id: segmentId(10),
      start: 208,
      end: 226,
      speaker_id: speakerId(3),
      text: "Доступ к тестовому контуру я уже проверил, эта задача выполнена. Критических ошибок входа не обнаружено. При высокой нагрузке ответы иногда приходят медленно.",
      needs_review: false,
    },
    {
      id: segmentId(11),
      start: 229,
      end: 251,
      speaker_id: speakerId(2),
      text: "Қазақша нұсқадағы мәтіндерді редактор тексеруі керек. «Өтініш» және «өтініш мәртебесі» атауларын бірізді қолданайық. Бұл тексеру дайын болған соң нұсқаулықты бекітеміз.",
      needs_review: false,
    },
    {
      id: segmentId(12),
      start: 254,
      end: 276,
      speaker_id: speakerId(1),
      text: "Итог: пилот без оплаты, два района, русский и казахский языки. Перед запуском проверяем согласие, инструкцию и основные сценарии. Срок отчёта и его исполнителя нужно уточнить отдельно.",
      needs_review: false,
    },
  ],
  summary: {
    overview:
      "Команда согласовала ограниченный пилот городского сервиса для обращений жителей двух районов. До запуска нужно подготовить инструкции на русском и казахском языках, проверить правовое уведомление и пройти основные сценарии. Относительные и противоречивые сроки оставлены на проверку; дата этой учебной встречи неизвестна.",
    decisions: [
      "Запустить пилот в двух районах: обращения о дворах и освещении.",
      "Подготовить интерфейс и инструкцию на русском и казахском языках.",
      "Перенести оплату на следующий этап.",
      "Провести показ операторам после согласования инструкции.",
    ],
    risks: [
      "Отдел правового сопровождения отсутствовал на встрече: поручение необходимо согласовать.",
      "Срок отчёта о доступности противоречив, ответственный не определён.",
      "Казахский текст инструкции требует проверки редактором.",
      "При высокой нагрузке в тестовом контуре наблюдались задержки.",
    ],
  },
  tasks: [
    {
      id: taskId(1),
      title: "Подготовить двуязычную инструкцию",
      description:
        "Описать создание обращения и проверку статуса на русском и казахском языках. Согласовать обе версии с редактором.",
      assignee_name: "Спикер 2",
      assignee_type: "person",
      assignee_speaker_id: speakerId(2),
      deadline_text: "к следующей пятнице",
      deadline_kind: "relative",
      due_date: null,
      status: "open",
      is_overdue: false,
      evidence_segment_ids: [segmentId(3), segmentId(4), segmentId(11)],
      needs_review: true,
      review_reasons: [RELATIVE_REASON],
      reviewed: false,
    },
    {
      id: taskId(2),
      title: "Подготовить правовое уведомление",
      description:
        "Подготовить текст уведомления об обработке персональных данных. Подтвердить поручение с отделом, который отсутствовал на встрече.",
      assignee_name: "Отдел правового сопровождения",
      assignee_type: "department",
      assignee_speaker_id: null,
      deadline_text: "до 25 сентября 2026 года",
      deadline_kind: "date",
      due_date: "2026-09-25",
      status: "open",
      is_overdue: false,
      evidence_segment_ids: [segmentId(5), segmentId(6)],
      needs_review: true,
      review_reasons: [
        "Исполнитель отсутствовал на встрече; необходимо подтвердить принятие поручения.",
      ],
      reviewed: false,
    },
    {
      id: taskId(3),
      title: "Собрать сценарии проверки пилота",
      description:
        "Проверить новую заявку, дубликаты, смену статуса и недоступность сервиса.",
      assignee_name: "Спикер 3",
      assignee_type: "person",
      assignee_speaker_id: speakerId(3),
      deadline_text: "до 26 сентября 2026 года",
      deadline_kind: "date",
      due_date: "2026-09-26",
      status: "in_progress",
      is_overdue: false,
      evidence_segment_ids: [segmentId(7)],
      needs_review: false,
      review_reasons: [],
      reviewed: false,
    },
    {
      id: taskId(4),
      title: "Подготовить отчёт о доступности",
      description:
        "Собрать результаты наблюдений, включая данные за выходные. До начала работы согласовать исполнителя и окончательный срок.",
      assignee_name: null,
      assignee_type: "unknown",
      assignee_speaker_id: null,
      deadline_text:
        "до 25 сентября 2026 года… перенесём на 28 сентября… окончательную дату пока не фиксируем",
      deadline_kind: "conflicting",
      due_date: null,
      status: "open",
      is_overdue: false,
      evidence_segment_ids: [segmentId(8), segmentId(12)],
      needs_review: true,
      review_reasons: [CONFLICT_REASON, ASSIGNEE_REASON],
      reviewed: false,
    },
    {
      id: taskId(5),
      title: "Провести показ для операторов",
      description:
        "Организовать короткую демонстрацию сервиса после согласования инструкции. Координатор пилота не участвовал в этой встрече.",
      assignee_name: "Координатор пилота",
      assignee_type: "person",
      assignee_speaker_id: null,
      deadline_text: "после согласования инструкции",
      deadline_kind: "event",
      due_date: null,
      status: "open",
      is_overdue: false,
      evidence_segment_ids: [segmentId(9)],
      needs_review: true,
      review_reasons: [EVENT_REASON],
      reviewed: false,
    },
    {
      id: taskId(6),
      title: "Проверить доступ к тестовому контуру",
      description:
        "Проверка входа завершена, критических ошибок не обнаружено. Задержки при нагрузке вынесены в риски.",
      assignee_name: "Спикер 3",
      assignee_type: "person",
      assignee_speaker_id: speakerId(3),
      deadline_text: null,
      deadline_kind: "unspecified",
      due_date: null,
      status: "done",
      is_overdue: false,
      evidence_segment_ids: [segmentId(10)],
      needs_review: false,
      review_reasons: [],
      reviewed: true,
    },
  ],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function dateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function refreshOverdue(meeting: Meeting): Meeting {
  const today = dateInTimezone(new Date(), meeting.timezone);
  meeting.tasks.forEach((task) => {
    task.is_overdue =
      task.due_date !== null &&
      task.deadline_kind === "date" &&
      task.due_date < today &&
      task.status !== "done";
  });
  return meeting;
}

function readMeeting(): Meeting {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const value = JSON.parse(stored) as Meeting;
      if (
        value.id === DEMO_MEETING_ID &&
        Array.isArray(value.tasks) &&
        Array.isArray(value.speakers) &&
        Array.isArray(value.segments)
      ) {
        return refreshOverdue(value);
      }
    }
  } catch {
    // Viewing the demo remains possible if storage is unavailable. Saving explicitly fails below.
  }
  return refreshOverdue(clone(demoMeeting));
}

function requireMeeting(id: string): Meeting {
  if (id !== DEMO_MEETING_ID)
    throw new ApiError(
      "Демонстрационное совещание не найдено. Откройте пример из списка.",
      "MEETING_NOT_FOUND",
      404,
    );
  return readMeeting();
}

function persist(meeting: Meeting): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meeting));
  } catch {
    throw new ApiError(
      "Браузер не разрешил сохранить изменения примера. Разрешите локальное хранилище и попробуйте снова.",
      "DEMO_STORAGE_UNAVAILABLE",
    );
  }
}

export const demoApi = {
  health(): Health {
    return {
      status: "degraded",
      models: { asr: false, diarization: false, extraction: false },
    };
  },
  listMeetings(): { items: MeetingListItem[] } {
    const { id, title, started_at, created_at, status } = readMeeting();
    return { items: [{ id, title, started_at, created_at, status }] };
  },
  getMeeting(id: string): Meeting {
    return requireMeeting(id);
  },
  updateSpeaker(meetingId: string, id: string, displayName: string) {
    const meeting = requireMeeting(meetingId);
    const speaker = meeting.speakers.find((item) => item.id === id);
    if (!speaker)
      throw new ApiError("Говорящий не найден.", "SPEAKER_NOT_FOUND", 404);
    if (!displayName.trim())
      throw new ApiError(
        "Введите имя или обозначение говорящего.",
        "VALIDATION_ERROR",
        422,
      );
    speaker.display_name = displayName.trim();
    speaker.identification = "confirmed";
    meeting.tasks.forEach((task) => {
      if (task.assignee_speaker_id === id)
        task.assignee_name = speaker.display_name;
    });
    persist(meeting);
    return clone(speaker);
  },
  updateTask(meetingId: string, id: string, changes: TaskPatch): Task {
    const meeting = requireMeeting(meetingId);
    const task = meeting.tasks.find((item) => item.id === id);
    if (!task)
      throw new ApiError("Поручение не найдено.", "TASK_NOT_FOUND", 404);
    if (changes.title !== undefined && !changes.title.trim())
      throw new ApiError(
        "Введите формулировку поручения.",
        "VALIDATION_ERROR",
        422,
      );
    const substantive = Object.keys(changes).some((key) => {
      const field = key as keyof TaskPatch;
      return (
        field !== "status" &&
        field !== "reviewed" &&
        changes[field] !== task[field]
      );
    });
    Object.assign(task, changes);
    if (substantive && changes.reviewed === undefined) task.reviewed = false;
    if (changes.due_date !== undefined) {
      if (changes.due_date) {
        task.deadline_kind = "date";
        task.review_reasons = task.review_reasons.filter(
          (reason) =>
            ![RELATIVE_REASON, CONFLICT_REASON, EVENT_REASON].includes(reason),
        );
      } else {
        const original = demoMeeting.tasks.find((item) => item.id === id)!;
        task.deadline_kind =
          original.deadline_kind === "date"
            ? "unspecified"
            : original.deadline_kind;
        const originalReasons = original.review_reasons.filter((reason) =>
          [RELATIVE_REASON, CONFLICT_REASON, EVENT_REASON].includes(reason),
        );
        task.review_reasons = [
          ...new Set([...task.review_reasons, ...originalReasons]),
        ];
      }
    }
    if (changes.assignee_name !== undefined) {
      if (changes.assignee_name?.trim())
        task.review_reasons = task.review_reasons.filter(
          (reason) => reason !== ASSIGNEE_REASON,
        );
      else if (!task.review_reasons.includes(ASSIGNEE_REASON))
        task.review_reasons.push(ASSIGNEE_REASON);
    }
    task.needs_review = task.review_reasons.length > 0;
    refreshOverdue(meeting);
    persist(meeting);
    return clone(task);
  },
};
