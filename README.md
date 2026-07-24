# MiraiPlay

Лёгкий **edge-шлюз** перед публичным аниме-API. Встаёт между клиентом
(SPA / Capacitor-приложение) и upstream-API, прозрачно проксирует запросы и
точечно дорабатывает ответы (премиум, роли, верификация, конфиги), добавляя
свои сервисы: Kodik-resolver, img-прокси, watch-together и Telegram-админку.

Стек: **Node 20+ · Fastify 5 · TypeScript**. Своя независимая реализация.

## Архитектура

```text
src/
├── config/        settings.ts        — валидация ENV (Zod), CORS-allowlist
├── upstream/      client.ts          — обёртка над fetch к upstream (UA-маскировка, anti-SSRF)
├── plugins/       guard.ts           — rate-limit + denylist + gateway-key (preHandler)
├── gateway/
│   ├── interceptors/                 — пострероутинговые правки ответов
│   │   ├── perks.ts                  — premium/roles/verified
│   │   ├── toggles.ts                — оверрайд /config/toggles
│   │   └── index.ts                  — реестр правил
│   └── passthrough.ts                — catch-all reverse-proxy
├── features/
│   ├── auth.ts                       — перехват /auth/signIn + уведомление в Telegram
│   ├── kodik.ts                      — резолвер потоков Kodik (/kodik/resolve)
│   ├── media.ts                      — img-прокси (/img) с allowlist хостов
│   ├── release.ts                    — обогащение карточки релиза (Shikimori)
│   ├── telegram.ts                   — webhook-админка (/tg/webhook)
│   ├── together.ts                   — watch-together (WS /together)
│   ├── player.ts                     — HTML-плеер, прогресс, галерея скриншотов
│   └── player.page.ts                — рендер HTML5-плеера (HLS, watch-together мост)
├── services/      blocklist.ts · monitor.ts · notifier.ts · shikimori.ts · screenshots.ts
│                  cache.ts (TTL-кэш) · progress.ts (кросс-девайс прогресс)
├── data/          overrides.toggles.json · roles.json · verified.json
├── app.ts                            — сборка Fastify-инстанса
└── main.ts                           — запуск + graceful shutdown
```

### Принцип работы

1. Запрос приходит на `/api/v1/*`.
2. `guard` считает метрики, применяет rate-limit, проверяет denylist и
   (если задан `GATEWAY_KEY`) ключ шлюза.
3. Специальные роуты (`auth`, `kodik`, `media`, `telegram`, `together`,
   `player`) обрабатываются адресно.
4. Всё остальное уходит в `passthrough` → upstream. Если для пути есть
   интерцептор — JSON-ответ дорабатывается перед отдачей.

## Данные (что и где править)

| Файл | Назначение |
|------|------------|
| `src/data/overrides.toggles.json` | оверрайды `/config/toggles` (отключение апдейтов, баннер) |
| `src/data/verified.json` | массив id профилей с принудительной «галочкой» |
| `src/data/roles.json` | `{ "<id>": [{ "name": "...", "color": "RRGGBB" }] }` — доп. роли |

Премиум (`is_sponsor`) выдаётся **глобально** всем профилям в
`gateway/interceptors/perks.ts` — отдельного списка не требует.

## Запуск

```bash
cp .env.example .env      # заполнить при необходимости
npm install
npm run dev               # tsx watch, авто-перезагрузка
# или
npm run build && npm start
# или
docker compose up -d --build
```

`npm run typecheck` — проверка типов без сборки.

## Конфигурация

См. `.env.example`. Ключевое:

- `UPSTREAM_BASE_URL` — адрес upstream-API.
- `GATEWAY_KEY` — если задан, все `/api/v1/*` (кроме публичных: `/img`,
  `/player`, `/tg/webhook`, `/together`, файлы скриншотов) требуют заголовок
  `X-Gateway-Key`. Для миграции со старого бэкенда также принимается
  `X-Proxy-Key`.
- `TELEGRAM_*` — бот-админка и уведомления о входах (опционально).
- `PREMIUM_EXPIRES_AT` — unix-срок выдаваемого премиума.

## Совместимость путей

Drop-in для существующего фронтенда:

```
GET    /api/v1/config/toggles
GET    /api/v1/profile/info
GET    /api/v1/profile/:id
GET    /api/v1/release/:id          (Shikimori-обогащение, кэш)
GET    /api/v1/episode/:id          (passthrough)
GET    /api/v1/img?u=<url>&w=<px>&fmt=<auto|webp|jpg|png>   (resize + WebP, кэш)
GET    /api/v1/kodik/resolve?url=<kodik>
GET    /api/v1/player?url=...&releaseId=...&sourceId=...&position=...
POST   /api/v1/auth/signIn
POST   /api/v1/player/progress
GET    /api/v1/player/progress?releaseId=&sourceId=&episode=   (token, resume)
GET    /api/v1/player/continue             (token, «продолжить просмотр»)
POST   /api/v1/player/screenshot          (token)
GET    /api/v1/player/screenshots         (token)
GET    /api/v1/player/screenshots/file/:bucket/:id
DELETE /api/v1/player/screenshots/:id     (token)
POST   /api/v1/tg/webhook
WS     /api/v1/together?key=<gateway-key>
*      /api/v1/*                    (общий проксируемый passthrough)
```

## Обогащение релиза

`GET /release/:id` (если `RELEASE_ENRICH=true`) добавляет в `note`: оценку
времени просмотра, данные Shikimori (рейтинг, главные персонажи, ссылка на
карточку) и список связанного аниме (`release.related_anime`). В отличие от
исходного проекта — **без гейтинга за премиум и без сторонней рекламы**:
обогащение доступно всем, заголовок берётся из `BRAND_LABEL`.

Запросы к Shikimori кэшируются (`services/cache.ts`, память + диск в
`STATE_DIR/cache/shikimori`): успешный результат живёт 12 ч, пустой/неудачный —
1 ч. Тела passthrough намеренно **не** кэшируются — в них есть per-user поля
(`is_viewed`, голоса), иначе состояние одного пользователя утекло бы другому.

## Оптимизация изображений

`/img` помимо анонимизации делает on-the-fly преобразование (`IMG_OPTIMIZE`):
WebP при `Accept: image/webp` и/или ресайз по `?w=`. Результат кэшируется на
диск (`STATE_DIR/cache/img`) по хэшу url+параметров. Любой сбой sharp —
прозрачный фолбэк на оригинал. Браузеры получают WebP автоматически (постеры
становятся ~в 4 раза легче) без изменений на фронте.

## Скриншоты и прогресс

Кадры из плеера сохраняются на сервере в «бакете» — это HMAC от токена
пользователя (нельзя перечислить чужую галерею, нет IDOR). URL файла сам по
себе является capability; удаление требует токен.

Тем же bucket-паттерном хранится **кросс-девайс прогресс просмотра**
(`services/progress.ts`): плеер шлёт позицию в `POST /player/progress`, при
открытии `/player` сервер подставляет сохранённую точку (resume работает на
новом устройстве без localStorage), а `GET /player/continue` отдаёт список
недосмотренных серий для блока «продолжить просмотр».

## Безопасность

- Строгая валидация ENV — нода не стартует с битым конфигом.
- Anti-SSRF: upstream-цель пиннится к origin из `UPSTREAM_BASE_URL`.
- На upstream уходит только allowlist заголовков + нативный User-Agent.
- Rate-limit по токену (честно за SNI-passthrough), denylist по IP/аккаунту/токену.
- img-прокси и upstream-вызовы скрывают реальный IP клиента.
