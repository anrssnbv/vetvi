> Для локального запуска без домена и внешнего OAuth используйте [stdio и Secure MCP Tunnel](local-chatgpt.md). Ниже сохранён дополнительный HTTP/OAuth-вариант.

# MCP и подключение ChatGPT

Для корзины проектов доступны `delete_project` и `restore_project` с обычными `id`, `expectedVersion`, `requestId`. Для `delete_project` также обязателен `confirmationTitle` с точным названием проекта. Активные незавершённые задачи блокируют удаление; иначе проект и его оставшиеся задачи перемещаются в корзину атомарно. Отменённые/архивные задачи не блокируют удаление; история и статусы сохраняются. Подтвердите отсутствие дальнейшей работы. `restore_project` восстанавливает только проект, задачи остаются в корзине. `list_projects(includeDeleted: true)` включает удалённые проекты; восстановление задачи автоматически возвращает её проект. По умолчанию удалённые проекты не показываются.

Сервер использует официальный `@modelcontextprotocol/sdk` и настоящий Streamable HTTP endpoint `/mcp`. JSON-ответы, stateless transport: каждый HTTP-запрос независимо проходит OAuth-проверку. GET/DELETE возвращают 405 после авторизации; SSE-сессия этому приложению не требуется. REST `/api/tools/*` предназначен интерфейсу и не подменяет MCP. Оба транспорта вызывают один `TaskService` и одну SQLite-базу.

## Локальная проверка

`npm test` запускает официальный MCP Client через HTTP против локального приложения. Тестовый OAuth issuer публикует временный JWKS, тест подписывает короткоживущие access tokens. Тест проверяет создание через MCP, видимость через UI API, изменение через UI API, чтение через MCP, завершение дочерней и родительской задачи по результату без ссылки, перезапуск сервера, сохранность истории, повторное открытие и восстановление удаления. Это проверка протокола и общей базы; это **не** вызов из настоящего ChatGPT и **не** полная проверка OAuth authorization-code flow.

Без OAuth `/mcp` отвечает 401 и не принимает UI cookie или постоянный API-ключ вместо access token. UI работает отдельно: пароль владельца, HttpOnly SameSite=Strict cookie, 12 часов, Origin/Host-проверки, ограничение попыток входа. Сессии хранятся в памяти и сбрасываются при перезапуске; задачи и история остаются в SQLite.

## Удалённое размещение

Публикация и платные ресурсы не создавались. Для подключения нужны выбранный владельцем HTTPS-домен, сервер, TLS reverse proxy и OAuth 2.1 провайдер. Reverse proxy должен сохранить публичный `Host` и маршрутизировать `/mcp` и `/.well-known/oauth-protected-resource/mcp`. Не раскрывайте Node-порт напрямую. Пароль UI и значения окружения передаются средствами развёртывания, не через Git или логи.

В окружении сервера задайте:

```dotenv
PUBLIC_BASE_URL=https://tasks.example.org
UI_ORIGIN=https://tasks.example.org
OWNER_SUBJECT=subject-владельца-у-провайдера
OAUTH_ISSUER=https://identity.example.org
OAUTH_AUDIENCE=https://tasks.example.org/mcp
OAUTH_JWKS_URL=https://identity.example.org/.well-known/jwks.json
SEED_DEMO=false
```

`OAUTH_ISSUER` должен точно соответствовать `iss` токена, включая завершающий `/`, если он есть у провайдера. Access token должен быть JWT с RS256 или ES256, корректной подписью из доверенного JWKS, `sub`, `iat`, `exp`, `aud` для этого `/mcp` и `scope` с `tasks:read`, дополнительно `tasks:write` для изменений. Проверяются issuer, audience, expiry, nbf при наличии, subject владельца и права каждой операции. Id tokens и токены для другого API не должны выдаваться провайдером с этим resource/audience. Сервер не принимает произвольный JWKS URL из запроса или токена.

OAuth-провайдер должен поддерживать authorization-code flow, PKCE S256, discovery (RFC8414 либо OIDC), resource indicators и совместимую регистрацию клиента: Client ID Metadata Documents, DCR либо предварительную регистрацию. Точный redirect URI возьмите из текущей страницы управления подключением ChatGPT; не используйте выдуманный или устаревший callback. Провайдер ограничивает вход владельцем. Настройка PKCE, согласия, отзыва токенов и callback выполняется у провайдера; приложение является resource server и не реализует собственный authorization server. Непрозрачные access tokens не поддерживаются: для такого провайдера понадобится отдельно реализованная и проверенная introspection.

После размещения:

1. Проверьте HTTPS, PRM discovery по `/.well-known/oauth-protected-resource/mcp` и 401 с `WWW-Authenticate: Bearer resource_metadata=...` для `/mcp` без токена.
2. В доступном вашему аккаунту режиме создания MCP-подключения ChatGPT укажите `https://tasks.example.org/mcp`, выберите OAuth и завершите вход владельцем. Наличие нужного режима и разрешения администратора зависит от аккаунта.
3. Вызовите `list_projects` из ChatGPT. Затем выполните синтетический сквозной сценарий с записью и чтением. Только успешный реальный вызов позволяет отметить интеграцию ChatGPT проверенной.
4. Проверьте отзыв доступа, истёкший токен, чужой `sub`, неправильный `aud` и токен только на чтение на реальном провайдере.

## Инструменты

Все инструменты видны через `tools/list`, с JSON Schema входов, верхнеуровневым `securitySchemes` и зеркалом `_meta.securitySchemes` OAuth scopes. Для этого используется публичный `server.setRequestHandler` официального SDK: SDK 1.x сам не выводит верхнеуровневое поле из `registerTool`. При недостаточных правах возвращается ошибка инструмента с `_meta["mcp/www_authenticate"]`. Общие права: `tasks:read` для чтения, `tasks:write` для изменений; владелец проверяется для каждой записи, связанного ID и операции.

| Инструмент | Основные аргументы |
| --- | --- |
| `list_projects` | `offset`, `limit`; возвращает также категории |
| `search_tasks` | `query`, `projectId`, `categoryId`, `status`, `due` (`overdue`/`today`), `archived`, `deleted`, `hideCompleted`, `offset`, `limit` |
| `get_task` | `id`; включая связи, прогресс, последние 100 событий истории |
| `get_subtree` | `id`, `depth` 0–20, `offset`, `limit` 1–200 |
| `get_changes` | `since` — числовой курсор, `offset`, `limit`, ответ `nextCursor` |
| `create_task` | `projectId`, `title`, необязательные `parentId`, `description`, `criteria`, `priority`, `status`, `dueDate` или `dueAt` |
| `update_task` | `id`, изменяемые поля; завершение запрещено |
| `move_task` | `id`, `parentId` или null, необязательные `projectId`, `order` |
| `add_dependency`, `remove_dependency` | `id`, `targetId` |
| `add_evidence` | `id`, `url`, `note` |
| `complete_task` | `id`, `result`, необязательные `evidenceUrl`, `evidenceNote`; критерии и ссылки необязательны |
| `reopen_task` | `id`, `reason` |
| `archive_task`, `restore_task` | `id`; восстановление также снимает архив |
| `create_category`, `create_project` | `title`, у проекта `categoryId` |
| `add_relation`, `remove_relation` | `id`, `targetId`; обычная связь без порядка выполнения |
| `set_position` | `id`, `x`, `y`; отдельно от смысловых связей |
| `preview_delete` | `id`; полный список затрагиваемых ID |
| `delete_task` | `id`, `subtree: true`, `previewIds` из актуального preview |
| `export_data`, `import_data` | экспорт без аргументов; импорт `data` с `formatVersion: 1` |

Каждое изменение требует `requestId` — уникальный ID логического запроса. Точный повтор с тем же ID возвращает уже сохранённый результат; изменение аргументов с тем же ID даёт `IDEMPOTENCY_CONFLICT`. Для изменения существующей задачи требуется `expectedVersion` из последнего чтения. `VERSION_CONFLICT` означает: перечитать запись, показать конфликт и сформировать новое осмысленное изменение с новым requestId. Автоматически перезаписывать чужие изменения нельзя. Успешное изменение возвращает сохранённую запись с новой версией.

Пример:

```json
{"name":"complete_task","arguments":{"id":"ID","expectedVersion":3,"requestId":"UNIQUE-REQUEST-ID","result":"Редакция подготовлена и проверена по критериям"}}
```

Сервер требует непустой результат и проверяет открытые подзадачи и зависимости. Критерии и ссылки необязательны. Он не способен доказать истинность содержимого внешнего подтверждения: ассистент или владелец должны проверить его фактически. Подготовка документа не подтверждает согласование. При сомнении используйте `review`. Текст задач, ссылок и внешних страниц не меняет выданные права. MCP не обеспечивает постоянный запуск ChatGPT или фоновое наблюдение.

## Проверенные первичные источники

Проверены 30 октября 2026 года:

- [MCP TypeScript SDK, stateless Streamable HTTP](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x/src/examples/server).
- [MCP authorization specification, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
- [OpenAI: Authenticate users](https://developers.openai.com/plugins/build/auth).

Версия SDK в lockfile определяет фактически реализованный протокол. Поддержка каждого нового изменения спецификации, поведение выбранного OAuth-провайдера и реальное подключение ChatGPT требуют отдельной внешней проверки.
