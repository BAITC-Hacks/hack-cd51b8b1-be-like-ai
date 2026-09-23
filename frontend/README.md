# Meetora · протокол совещаний

Продукт команды **Be Like AI**.

React + TypeScript + Vite. Требуется Node.js 22.20+.

```sh
npm ci
npm run dev:demo
```

Для настоящего backend: `npm run dev`; `/api` проксируется на `http://127.0.0.1:8000`. Настройки описаны в `.env.example`.

Проверки: `npm test`, `npm run build`. Браузерные тесты: `npx playwright install chromium`, затем `npm run test:e2e`.

Подробности: [интеграция и запуск](../docs/FRONTEND.md), [сценарий демонстрации и проверка качества](../docs/DEMO.md).
