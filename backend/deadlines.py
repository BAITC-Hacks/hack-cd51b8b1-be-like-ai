from datetime import date, datetime, timedelta
import re
from zoneinfo import ZoneInfo
from .schemas import Meeting


MONTHS = {
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'мая': 5, 'май': 5,
    'июн': 6, 'июл': 7, 'август': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
    'қаңтар': 1, 'ақпан': 2, 'наурыз': 3, 'сәуір': 4, 'мамыр': 5, 'маусым': 6,
    'шілде': 7, 'тамыз': 8, 'қыркүйек': 9, 'қазан': 10, 'қараша': 11, 'желтоқсан': 12,
}
ORDINALS = {'перв': 1, 'втор': 2, 'треть': 3, 'четвёрт': 4, 'четверт': 4,
            'пят': 5, 'шест': 6, 'седьм': 7, 'восьм': 8, 'девят': 9, 'десят': 10,
            'одиннадцат': 11, 'двенадцат': 12, 'тринадцат': 13, 'четырнадцат': 14,
            'пятнадцат': 15, 'шестнадцат': 16, 'семнадцат': 17, 'восемнадцат': 18,
            'девятнадцат': 19, 'двадцат': 20, 'тридцат': 30}
COUNTS = {'один': 1, 'одну': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3,
          'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'бір': 1, 'екі': 2, 'үш': 3}


def ordinal_day(text: str) -> int | None:
    words = text.strip().split()
    if not words:
        return None
    last = words[-1]
    if last.isdigit():
        return int(last)
    result = next((value for prefix, value in sorted(ORDINALS.items(), key=lambda p: -len(p[0])) if last.startswith(prefix)), None)
    if result is not None and result < 10 and len(words) > 1:
        if words[-2] == 'двадцать':
            result += 20
        elif words[-2] == 'тридцать':
            result += 30
    return result


def resolve_deadline(raw: str | None, kind: str, started_at: datetime | None, tz: str):
    """Conservative normalization. No invented reference date or arbitrary end of week."""
    if not raw or not raw.strip():
        return None, 'unspecified', ['Срок не указан']
    text = raw.lower().strip()
    if kind == 'conflicting':
        return None, kind, ['В разговоре есть противоречивые сроки']
    if kind == 'event' or re.search(r'после\s+(совещания|встречи|согласования)', text):
        return None, 'event', ['Срок зависит от события']
    base = started_at.astimezone(ZoneInfo(tz)).date() if started_at else None
    iso = re.search(r'\b(20\d{2})-(\d{2})-(\d{2})\b', text)
    dotted = re.search(r'\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b', text)
    try:
        if iso:
            return date(*map(int, iso.groups())), 'date', []
        if dotted:
            day, month, year = map(int, dotted.groups())
            return date(year, month, day), 'date', []
        for root, month in MONTHS.items():
            found = re.search(r'(?<!\w)' + root + r'\w*', text)
            if found:
                day = ordinal_day(text[:found.start()])
                if day is None:
                    break
                year_match = re.search(r'\b20\d{2}\b', text[found.end():])
                if not year_match and base is None:
                    return None, 'date', ['Неизвестен год совещания']
                year = int(year_match.group()) if year_match else base.year
                reasons = [] if year_match else ['Год принят по дате совещания; проверьте срок']
                return date(year, month, day), 'date', reasons
        if base is None:
            return None, kind if kind != 'unspecified' else 'relative', ['Для расчёта срока нужна дата совещания']
        relative = re.search(r'\b(?:через|за)\s+(\d+|один|одну|одна|два|две|три|четыре|пять|шесть|семь)?\s*(день|дня|дней|недел\w*)', text)
        if relative:
            count_text = relative.group(1) or '1'
            count = int(count_text) if count_text.isdigit() else COUNTS[count_text]
            days = count * (7 if relative.group(2).startswith('недел') else 1)
            return base + timedelta(days=days), 'relative', []
        if text == 'завтра':
            return base + timedelta(days=1), 'relative', []
        if text == 'сегодня':
            return base, 'relative', []
    except (ValueError, OverflowError):
        return None, kind, ['Некорректная календарная дата; требуется проверка']
    return None, kind if kind != 'unspecified' else 'relative', ['Уточните календарную дату или период исполнения']


def refresh_overdue(meeting: Meeting, now: datetime | None = None) -> Meeting:
    today = (now or datetime.now(ZoneInfo(meeting.timezone))).astimezone(ZoneInfo(meeting.timezone)).date()
    for task in meeting.tasks:
        task.is_overdue = bool(task.due_date and task.due_date < today and task.status != 'done')
    return meeting
