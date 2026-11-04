# Локальный запуск и ChatGPT

Веб-приложение работает на вашем компьютере. Вход — `OWNER_LOGIN` (по умолчанию `admin`) и `OWNER_PASSWORD` из игнорируемого `.env`. Внешний OAuth-провайдер и публичный домен для этого режима не нужны.

```powershell
npm run build
npm start
```

Адрес: http://127.0.0.1:3001. При `HOST=127.0.0.1` сервер слушает только loopback. Пароль проверяется через scrypt; сессия HttpOnly/SameSite. Неверный логин или пароль дают общий отказ. `OWNER_SUBJECT` — стабильный владелец записей; не меняйте его для настройки туннеля.

## Локальный MCP

ChatGPT → Secure MCP Tunnel OpenAI → локальный `tunnel-client` → `server/stdio.ts` → тот же `TaskService` и `DATABASE_PATH`, что у UI.

stdio MCP не открывает сетевой порт. Его запускает доверенный локальный процесс. Для него указан `noauth`: доступ ограничивает привязка туннеля к вашему аккаунту/workspace. Это не отключает пароль UI и не открывает HTTP `/mcp`. Необязательный HTTP OAuth-вариант сохранён.

Логин/пароль UI не является авторизацией MCP из ChatGPT. Пароль приложения не передаётся ChatGPT. Официальный локальный путь использует доступ к туннелю.

`npm test` запускает настоящий stdio MCP дочерним процессом и проверяет общий SQLite с UI, обратное чтение и ожидание параллельной транзакции. `npm run mcp:local` предназначен MCP-клиенту: в его stdin передаются JSON-RPC, не обычные команды.

## Туннель

Нужны tunnel ID, runtime-ключ OpenAI с Tunnels Read + Use и связанный ChatGPT workspace. Ключ нужен туннельному клиенту, а не веб-приложению. Не передавайте его в чат, аргументы команд, репозиторий или логи.

Официальный Windows-клиент установлен в `.local-tools/tunnel-client/tunnel-client.exe`; SHA-256 проверен по официальному `SHA256SUMS.txt`. Каталог исключён из Git. Проверены `help quickstart`, `init --help`, `profiles samples show sample_mcp_stdio_local`. В профиле используется ссылка `env:CONTROL_PLANE_API_KEY`, а не секрет.

После получения реального `$tunnelId` создайте профиль из корня проекта:

```powershell
$tunnelClient = Join-Path $PWD '.local-tools/tunnel-client/tunnel-client.exe'
$nodeBinary = (Get-Command node).Source
$loaderUri = ([Uri](Join-Path $PWD 'node_modules/tsx/dist/loader.mjs')).AbsoluteUri
$stdioFile = Join-Path $PWD 'server/stdio.ts'
$mcpCommand = '"' + $nodeBinary + '" --import "' + $loaderUri + '" "' + $stdioFile + '"'
& $tunnelClient init --sample sample_mcp_stdio_local --profile vetvi-local --profile-dir "$PWD/.local-tools/tunnel-profile" --tunnel-id $tunnelId --mcp-command $mcpCommand --health-listen-addr 127.0.0.1:0
```

С ключом, безопасно доступным процессу как `CONTROL_PLANE_API_KEY`, выполните `doctor --profile vetvi-local --profile-dir ... --explain`, затем `run` с тем же профилем. Для управляемого постоянного процесса есть `runtimes connect`; сначала читайте актуальный `--help`. Не запускайте два клиента одного профиля случайно.

В ChatGPT Plugins: `+` → Add custom MCP server → Connection: Tunnel → ваш туннель → Authentication: No authentication. Проверьте предупреждение о доступе, создайте личный plugin и установите его. Вызовите `list_projects` и `search_tasks`. Клиент должен работать во время каждого вызова. Запись разрешайте только своему личному workspace.

## Управление экземпляром

Управление после настройки:

```powershell
npm run tunnel:start
npm run tunnel:status
npm run tunnel:doctor
npm run tunnel:stop
```

`start` повторно использует существующий runtime и не создаёт новый туннель или ключ. Скрипт загружает секрет из игнорируемого файла и передаёт клиенту только ссылку `env:CONTROL_PLANE_API_KEY`. `.local-tools/tunnel-connection.json` хранит только tunnel ID; YAML-профиль не содержит буквального ключа. Для работы ChatGPT браузерный UI приложения не обязателен: stdio обращается к той же SQLite самостоятельно. Компьютер и runtime должны работать; после перезагрузки используйте `tunnel:start`. Автозапуск Windows не настраивался.

В Windows пути внутри `mcp-command` должны использовать прямые слеши `/`: парсер клиента иначе удаляет обратные слеши и не находит Node. Скрипт `scripts/tunnel.mjs` учитывает это и использует абсолютные пути, включая URI загрузчика tsx.

Для проверки вызовите `list_projects` и `search_tasks`, затем создайте отдельную синтетическую задачу и сравните её состояние и историю в UI. Личные чаты, снимки и отчёты рабочего экземпляра в репозиторий не входят.

Источники: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [добавление MCP в ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server).
