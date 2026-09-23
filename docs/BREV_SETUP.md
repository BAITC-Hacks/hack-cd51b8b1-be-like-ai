# Подготовка GPU-сервера Brev

Проверено по пользовательским скриншотам и выводу терминала: Ubuntu, Python 3.12.14, A100-SXM4-40GB, 40960 MiB видеопамяти, около 260 GiB свободного диска. PyTorch 2.8.0+cu128 видит CUDA и успешно выполняет умножение матриц. Все три модели скачаны; после обновления pyannote.audio до 4.0.3 скрипт завершился с `MODEL CHECK OK`. Проверены инициализация на тишине и извлечение одного поручения из синтетического текста; [проверка качества реальной речи ещё требуется](GPU_VALIDATION.md).

Полная инструкция скачивания весов и запуска приложения находится в [README](../README.md#запуск-на-brev-a100). Этот файл описывает подготовку окружения отдельно от приложения.

## Автоматический вариант

Скопировать `scripts/setup_brev.sh` на сервер через доступный файловый интерфейс JupyterLab или SSH/SCP и выполнить в серверном терминале:

```bash
bash setup_brev.sh
```

По умолчанию окружение размещается в `~/workspace/hackalem-ai/.venv`. Можно указать другую директорию проекта:

```bash
HACKALEM_ROOT=/home/ubuntu/workspace/my-project bash setup_brev.sh
```

Скрипт устанавливает системные библиотеки и Python-пакеты, создаёт `activate_hackalem.sh`, проверяет вычисление на GPU и импорты библиотек. При ошибке останавливается. Веса моделей не скачивает, аудио никуда не передаёт и внешние порты не открывает.

После успешного запуска в каждом новом терминале:

```bash
source ~/workspace/hackalem-ai/activate_hackalem.sh
```

`runtime-lock.txt` содержит версии реально установленных пакетов. Фиксация основных версий и документированная совместимость пока не заменяют проверку скрипта на самой VM.

## Первый шаг вручную

Если удобнее вставлять команды, достаточно начать с проверки PyTorch. Выполнять блоки по очереди в терминале Brev; при ошибке сохранить её вывод и остановиться.

```bash
sudo apt-get update
sudo apt-get install -y python3-venv ffmpeg libsndfile1 fonts-dejavu-core git tmux
```

```bash
mkdir -p ~/workspace/hackalem-ai
cd ~/workspace/hackalem-ai
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

```bash
python - <<'PY'
import torch
print('PyTorch:', torch.__version__)
print('CUDA available:', torch.cuda.is_available())
assert torch.cuda.is_available(), 'GPU недоступна из PyTorch'
print('GPU:', torch.cuda.get_device_name(0))
x = torch.ones((64, 64), device='cuda')
assert (x @ x)[0, 0].item() == 64.0
torch.cuda.synchronize()
print('GPU test: OK')
PY
```

После этого полный скрипт можно запустить повторно: уже установленные подходящие пакеты будут использованы.

## Доступ к весам диаризации

Владелец аккаунта самостоятельно входит на Hugging Face и открывает [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1). Для скачивания требуется принять условия владельца модели. Затем создать токен для чтения модели и выполнить вход командой `hf auth login` после установки `huggingface-hub`.

Токен вводится в интерактивный запрос на сервере, не в переписку, командную строку с аргументом или репозиторий. На вопрос о добавлении токена в Git credentials для нашей задачи достаточно ответить `n`. Это доступ к скачиванию весов; обработка записей должна выполняться собственными моделями на согласованной инфраструктуре.

## Основания выбора версий

- [PyTorch 2.8.0 и CUDA 12.8: официальная команда установки](https://pytorch.org/get-started/previous-versions/#v280).
- [Таблица совместимости TorchCodec](https://github.com/meta-pytorch/torchcodec): 0.7 соответствует PyTorch 2.8.
- [Зависимости pyannote.audio 4.0.3](https://pypi.org/project/pyannote.audio/4.0.3/): закреплены PyTorch/torchaudio 2.8.0 и TorchCodec 0.7.0; они совпадают с версиями проекта.
- [Требования faster-whisper к CUDA-библиотекам](https://github.com/SYSTRAN/faster-whisper#gpu): CUDA 12, cuBLAS и cuDNN 9. Скрипт добавляет пути библиотек из виртуального окружения перед запуском Python.

Драйвер, установленный организаторским окружением, сохраняется. Совместимость библиотек и работа реальных моделей окончательно подтверждаются на VM.

## Ошибка `Weights only load failed` / `Specifications`

Старая фиксация `pyannote.audio==4.0.1` несовместима с поведением загрузчика Lightning 2.6+: при загрузке checkpoint возникает `Unsupported global: pyannote.audio.core.task.Specifications`. В pyannote 4.0.3 есть [официальное исправление загрузчика](https://github.com/pyannote/pyannote-audio/pull/1962); обе точки загрузки checkpoint явно задают нужный режим. Используются веса официального `pyannote/speaker-diarization-community-1`, скачанные скриптом проекта.

Для уже распакованного старого архива выполнить в терминале Brev из `~/workspace/hackalem-ai`, с активным venv:

```bash
sed -i 's/pyannote\.audio==4\.0\.1/pyannote.audio==4.0.3/g' requirements-inference.txt scripts/setup_brev.sh
python -m pip install "pyannote.audio==4.0.3"
```

После успешной установки:

```bash
python -m pip check
source scripts/activate_env.sh
python scripts/check_models.py
```

Скачивание весов заново не требуется. Глобальные переменные обхода `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD` и изменения `site-packages` не нужны. Совместимость зависимостей и наличие исправления проверены по метаданным и коду опубликованного wheel; прохождение GPU-проверки определяется результатом повторного запуска на VM. После успеха сохранить окружение: `python -m pip freeze > runtime-lock.txt`.
