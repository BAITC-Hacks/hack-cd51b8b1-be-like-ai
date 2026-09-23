import type {
  Health,
  Meeting,
  MeetingListItem,
  ProcessingStatus,
  Speaker,
  Task,
  TaskPatch,
} from "../types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(
    message: string,
    code = "REQUEST_FAILED",
    status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Accept an API base path, a full API URL, or an origin (which uses /api). */
export function normalizeApiBase(value?: string): string {
  const base = value?.trim().replace(/\/+$/, "");
  if (!base || base === "/") return "/api";
  if (base.startsWith("/") && !base.startsWith("//") && !/[?#]/.test(base))
    return base;
  try {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid API URL");
    }
    return url.pathname === "/" ? `${url.origin}/api` : base;
  } catch {
    throw new ApiError(
      "Проверьте VITE_API_BASE_URL: нужен путь /api или адрес https://ваш-сервер/api.",
      "INVALID_API_BASE",
    );
  }
}

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === "true";
export const API_BASE_URL = normalizeApiBase(import.meta.env.VITE_API_BASE_URL);

type JsonObject = Record<string, unknown>;
function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

const fieldNames: Record<string, string> = {
  file: "Файл",
  title: "Название",
  started_at: "Дата совещания",
  timezone: "Часовой пояс",
  participants_notified: "Уведомление участников",
  due_date: "Срок",
  display_name: "Имя говорящего",
  assignee_name: "Исполнитель",
  status: "Статус",
};

/** Application errors and FastAPI validation errors share a readable UI message. */
export function parseApiError(payload: unknown, status: number): ApiError {
  const body = asObject(payload);
  const appError = asObject(body?.error);
  if (typeof appError?.message === "string") {
    return new ApiError(
      appError.message,
      typeof appError.code === "string" ? appError.code : "REQUEST_FAILED",
      status,
    );
  }
  const detail = body?.detail;
  if (typeof detail === "string")
    return new ApiError(detail, "VALIDATION_ERROR", status);
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((entry) => {
      const issue = asObject(entry);
      if (typeof issue?.msg !== "string") return [];
      const location = Array.isArray(issue.loc)
        ? issue.loc.filter(
            (part) => !["body", "query", "path"].includes(String(part)),
          )
        : [];
      const field = location
        .map((part) => fieldNames[String(part)] ?? String(part))
        .join(" → ");
      return [field ? `${field}: ${issue.msg}` : issue.msg];
    });
    if (messages.length)
      return new ApiError(messages.join("\n"), "VALIDATION_ERROR", status);
  }
  const detailObject = asObject(detail);
  if (typeof detailObject?.message === "string")
    return new ApiError(detailObject.message, "REQUEST_FAILED", status);
  const fallback: Record<number, string> = {
    401: "Сессия завершилась. Войдите в приложение снова.",
    403: "Нет доступа к этому совещанию.",
    404: "Совещание или запрошенный ресурс не найдены.",
    409: "Результат ещё не готов. Дождитесь завершения обработки.",
    413: "Запись слишком большая для сервера. Выберите файл меньшего размера.",
    415: "Сервер не поддерживает этот формат записи. Используйте MP3 или WAV.",
    422: "Проверьте заполненные поля.",
    429: "Слишком много запросов. Попробуйте немного позже.",
    502: "Backend пока недоступен. Проверьте, что сервер запущен.",
    503: "Сервис или модели пока не готовы. Попробуйте позже.",
    504: "Сервер не ответил вовремя. Попробуйте ещё раз.",
  };
  return new ApiError(
    fallback[status] ?? `Ошибка сервера (${status}). Попробуйте ещё раз.`,
    `HTTP_${status}`,
    status,
  );
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (
      init.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ApiError(
      "Не удалось связаться с сервером. Проверьте соединение и доступность backend.",
      "NETWORK_ERROR",
    );
  }
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw parseApiError(payload, response.status);
  }
  return response;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (
      init.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ApiError(
      "Сервер вернул некорректный ответ. Проверьте адрес API и повторите запрос.",
      "INVALID_RESPONSE",
      response.status,
    );
  }
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return json<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function meetingPath(id: string): string {
  return `/meetings/${encodeURIComponent(id)}`;
}

async function mocks(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { demoApi } = await import("./demo");
  signal?.throwIfAborted();
  return demoApi;
}

export interface CreateMeetingInput {
  file: File;
  title: string;
  started_at?: string;
  timezone: string;
  participants_notified: boolean;
}

export const api = {
  async health(signal?: AbortSignal): Promise<Health> {
    if (USE_MOCKS) return (await mocks(signal)).health();
    return json<Health>("/health", { signal });
  },

  async listMeetings(
    signal?: AbortSignal,
  ): Promise<{ items: MeetingListItem[] }> {
    if (USE_MOCKS) return (await mocks(signal)).listMeetings();
    return json<{ items: MeetingListItem[] }>("/meetings", { signal });
  },

  async getMeeting(id: string, signal?: AbortSignal): Promise<Meeting> {
    if (USE_MOCKS) return (await mocks(signal)).getMeeting(id);
    return json<Meeting>(meetingPath(id), { signal });
  },

  async createMeeting(
    input: CreateMeetingInput,
    signal?: AbortSignal,
  ): Promise<{ meeting_id: string; status: ProcessingStatus }> {
    if (USE_MOCKS)
      throw new ApiError(
        "Загрузка недоступна в демонстрационном режиме. Для обработки записи подключите backend и выключите VITE_USE_MOCKS.",
        "DEMO_UPLOAD_UNAVAILABLE",
      );
    const form = new FormData();
    form.append("file", input.file);
    form.append("title", input.title);
    if (input.started_at) form.append("started_at", input.started_at);
    form.append("timezone", input.timezone);
    form.append("participants_notified", String(input.participants_notified));
    return json<{ meeting_id: string; status: ProcessingStatus }>("/meetings", {
      method: "POST",
      body: form,
      signal,
    });
  },

  async updateSpeaker(
    meetingId: string,
    speakerId: string,
    displayName: string,
  ): Promise<Speaker> {
    if (USE_MOCKS)
      return (await mocks()).updateSpeaker(meetingId, speakerId, displayName);
    return patch<Speaker>(
      `${meetingPath(meetingId)}/speakers/${encodeURIComponent(speakerId)}`,
      { display_name: displayName },
    );
  },

  async updateTask(
    meetingId: string,
    taskId: string,
    changes: TaskPatch,
  ): Promise<Task> {
    if (USE_MOCKS)
      return (await mocks()).updateTask(meetingId, taskId, changes);
    return patch<Task>(
      `${meetingPath(meetingId)}/tasks/${encodeURIComponent(taskId)}`,
      changes,
    );
  },

  audioUrl(meetingId: string): string | null {
    return USE_MOCKS ? null : `${API_BASE_URL}${meetingPath(meetingId)}/audio`;
  },

  async downloadExport(
    meetingId: string,
    format: "pdf" | "docx",
  ): Promise<void> {
    if (USE_MOCKS)
      throw new ApiError(
        "Экспорт требует подключённого backend. В демонстрационном режиме документ не создаётся.",
        "DEMO_EXPORT_UNAVAILABLE",
      );
    const response = await request(
      `${meetingPath(meetingId)}/export?format=${format}`,
    );
    const contentType = response.headers.get("Content-Type") ?? "";
    if (/text\/html|application\/json/i.test(contentType)) {
      throw new ApiError(
        "Сервер вернул страницу или JSON вместо документа. Проверьте настройку экспорта на backend.",
        "INVALID_EXPORT",
        response.status,
      );
    }
    const blob = await response.blob();
    if (blob.size === 0)
      throw new ApiError(
        "Сервер вернул пустой документ. Повторите экспорт.",
        "EMPTY_EXPORT",
        response.status,
      );
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const encodedFilename = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(
      disposition,
    )?.[1];
    const simpleFilename =
      /filename\s*=\s*"([^"]+)"/i.exec(disposition)?.[1] ??
      /filename\s*=\s*([^;]+)/i.exec(disposition)?.[1];
    let filename = simpleFilename?.trim() || `protocol-${meetingId}.${format}`;
    if (encodedFilename) {
      try {
        filename = decodeURIComponent(encodedFilename.trim());
      } catch {
        /* Use the safe fallback filename. */
      }
    }
    filename = filename.replace(/[\\/\x00-\x1f]/g, "_");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    // Browsers may need the object URL after the click dispatch has completed.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
};
