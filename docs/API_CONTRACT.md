# Контракт API v0.1 для параллельной работы

Статус: endpoints реализованы и проверены локальными тестами с заменой тяжёлых моделей тестовым обработчиком. Реальный запуск моделей на A100 и интеграция с frontend ещё требуют проверки. Владелец backend — лидер. Владелец frontend — второй участник. Изменения формата передавать друг другу до интеграции.

## Общие правила

- Базовый префикс: `/api`. В разработке Vite проксирует его на `http://127.0.0.1:8000`; в демонстрации UI и API используют один origin.
- JSON в UTF-8. Идентификаторы — строки UUID; фронтенд не извлекает из них смысл.
- Все таймкоды — секунды от начала исходного аудио. Не переименовывать поля и не переводить их на русский.
- Пустое неизвестное значение — `null`, пустая коллекция — `[]`.
- Ошибки приложения: `{"error":{"code":"MODEL_UNAVAILABLE","message":"Модель ещё не готова"}}`. Ошибки проверки запроса могут приходить в стандартном FastAPI `detail`; UI обрабатывает оба формата.
- Секреты моделей не передаются в браузер. Для защищённых ссылок используются текущая сессия/авторизация доступа к приложению.
- Демо-данные фронтенда включаются только явным `VITE_USE_MOCKS=true` с постоянной отметкой «Демонстрационные данные». При сетевой ошибке переключаться на них автоматически запрещено.

## Endpoints

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | Готовность API и моделей |
| POST | `/api/session` | Вход по коду: `{"token":"код"}`, устанавливает HttpOnly cookie |
| DELETE | `/api/session` | Выход и удаление cookie |
| POST | `/api/meetings` | Загрузка файла, создание записи и задания; ответ 202 |
| GET | `/api/meetings` | Список совещаний: `{"items":[MeetingListItem]}` |
| GET | `/api/meetings/{id}` | Статус обработки и полный текущий результат |
| GET | `/api/meetings/{id}/audio` | Воспроизведение исходного аудио, поддержка Range |
| PATCH | `/api/meetings/{id}/speakers/{speaker_id}` | Правка имени: `{"display_name":"Участник 1"}` |
| PATCH | `/api/meetings/{id}/tasks/{task_id}` | Правка поручения |
| GET | `/api/meetings/{id}/export?format=pdf` | Файл PDF с Content-Disposition attachment |
| GET | `/api/meetings/{id}/export?format=docx` | Файл DOCX с Content-Disposition attachment |

Для загрузки используется `multipart/form-data`: `file` обязательно; `title` обязательно; `started_at` — ISO 8601 с UTC offset, опционально; `timezone` — IANA, по умолчанию `Asia/Almaty`; `participants_notified` — `true`, подтверждение уведомления участников. Неизвестную дату не заменять сегодняшней: поле `started_at` пропускать. MP3/WAV — первый обязательный набор загрузки; остальные форматы показывать как доступные только после фактической поддержки backend.

Ответ загрузки: `{"meeting_id":"UUID","status":"queued"}`. Фронтенд опрашивает GET совещания раз в две секунды до `ready` или `failed`, прекращает опрос после ухода со страницы. Прогресс не имитировать таймером: API сообщает этап, процент может быть `null`.

## Типы TypeScript

```typescript
type ProcessingStatus = 'queued' | 'processing' | 'ready' | 'failed';
type ProcessingStage =
  | 'queued' | 'decode' | 'transcribe' | 'diarize' | 'extract' | 'complete';
type TaskStatus = 'open' | 'in_progress' | 'done';
type DeadlineKind = 'date' | 'relative' | 'event' | 'unspecified' | 'conflicting';

interface Health {
  status: 'ok' | 'degraded';
  models: { asr: boolean; diarization: boolean; extraction: boolean };
}

interface MeetingListItem {
  id: string;
  title: string;
  started_at: string | null;
  created_at: string;
  status: ProcessingStatus;
}

interface Speaker {
  id: string;
  label: string;             // например SPEAKER_00
  display_name: string;      // например «Спикер 1» до сопоставления
  identification: 'unknown' | 'suggested' | 'confirmed';
}

interface Segment {
  id: string;
  start: number;
  end: number;
  speaker_id: string | null;
  text: string;
  needs_review: boolean;
}

interface Task {
  id: string;
  title: string;
  description: string;
  assignee_name: string | null;
  assignee_type: 'person' | 'department' | 'unknown';
  assignee_speaker_id: string | null;
  deadline_text: string | null;   // исходная формулировка
  deadline_kind: DeadlineKind;
  due_date: string | null;        // YYYY-MM-DD, только если дата определена
  status: TaskStatus;
  is_overdue: boolean;           // вычисляет backend в timezone совещания
  evidence_segment_ids: string[];
  needs_review: boolean;
  review_reasons: string[];
  reviewed: boolean;
}

interface Meeting extends MeetingListItem {
  timezone: string;
  duration_seconds: number | null;
  stage: ProcessingStage;
  progress: number | null;
  error: {code: string; message: string} | null;
  speakers: Speaker[];
  segments: Segment[];
  summary: {overview: string; decisions: string[]; risks: string[]};
  tasks: Task[];
}
```

При `failed` сохраняется последний этап, `error` содержит причину. При `ready` все коллекции присутствуют; поручений может не быть. Саммари до готовности имеет пустую строку и пустые массивы.

## Правки и поведение UI

PATCH поручения принимает подмножество: `title`, `description`, `assignee_name`, `assignee_type`, `assignee_speaker_id`, `due_date`, `status`, `reviewed`. Возвращает целиком обновлённый `Task`. Backend сохраняет исходную формулировку срока и источники; после явного назначения даты пересчитывает `deadline_kind` и признаки проверки. Ошибку сохранения показывать рядом с формой, не выдавать правку за сохранённую.

Имя говорящего и ответственный задачи не обязаны совпадать. Исполнитель может вообще отсутствовать среди говорящих. Изменение имени спикера обновляет связанные представления, но не назначает ему все поручения из его реплик.

«Просрочено» — вычисляемый признак: дата определена, локальная дата уже позже `due_date`, задача ещё не `done`. День срока включительно не считается просрочкой. Для неизвестного/событийного срока просрочку не вычислять. Относительную формулировку без исходной даты отображать текстом и с отметкой проверки.

Кнопка «Источник» ищет `evidence_segment_ids`, прокручивает транскрипт и переводит аудиоплеер на начало первой найденной реплики. Отсутствующий сегмент — явное отсутствие подтверждения, а не случайная реплика.

Экспортировать только `ready`; иначе backend отвечает 409. Экспорт отражает последнюю сохранённую версию. Если остались неоднозначности, UI предупреждает о них, а документ обозначает их как требующие уточнения.
