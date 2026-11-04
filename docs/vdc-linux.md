# Перенос «Ветвей» на Linux VDC

Дополнение 30.10.2026: после закрытого переноса владелец выбрал общий HTTP-вход на порту 80. [Отдельная инструкция `/vetvi/`](public-http.md) описывает это исключение, префикс UI/API, настройки и проверки. Ниже сохранён первоначальный вариант через SSH.

Руководство подготовлено 30.10.2026 по текущему коду. Команды выполняет владелец; сервер VDC пока не проверен и не изменён.

## 1. Схема и условия

Первый запуск: Ubuntu 24.04 LTS, systemd, Node.js 24 (не ниже 24.12), локальный диск SQLite. Один сервер, одна база. Для личного использования начальный ориентир — 2 vCPU, 2 ГБ RAM и 10 ГБ диска; это оценка, нагрузочный тест не проводился.

- Браузер → SSH-проброс → веб-приложение на VDC.
- ChatGPT → существующий Secure MCP Tunnel → tunnel-client на VDC → stdio MCP → та же SQLite.
- Вход в веб-приложение: admin и ваш пароль. MCP получает доступ через привязку туннеля к аккаунту/workspace, а не через этот пароль.
- Входящий SSH разрешён с вашего IP/VPN; 3001 и административный порт туннеля наружу не открываются.
- VDC нужен исходящий HTTPS к api.openai.com:443. При установке также нужны nodejs.org, registry.npmjs.org, GitHub и хосты загрузки его release assets; DNS и корректное время.
- Если VDC корпоративный, исходящий туннель и передачу содержимого задач в ChatGPT нужно согласовать с владельцем сети/ИБ.

Домен не требуется для такого запуска. Постоянный HTTPS-адрес описан в конце.

Во всех командах замените SERVER_IP и SSH_USER на свои значения. Linux-блоки выполняются в Bash, Windows-блоки — в PowerShell. Не вставляйте команды всех блоков сразу.

## 2. Подготовить сервер

Подключитесь из Windows:

```powershell
ssh SSH_USER@SERVER_IP
```

На Linux:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils unzip python3 sqlite3
sudo useradd --system --create-home --home-dir /var/lib/vetvi --shell /usr/sbin/nologin vetvi
sudo install -d -o vetvi -g vetvi -m 750 /opt/vetvi /var/lib/vetvi/data /var/lib/vetvi/backups /var/lib/vetvi/tunnel-profile
sudo install -d -o root -g vetvi -m 750 /etc/vetvi
```

Если пользователь vetvi уже существует, не выполняйте useradd повторно. Сетевые ACL VDC настройте через принятую у вас процедуру; не закрывайте текущий SSH-доступ.

Установите свежую patch-версию ветки Node 24 из официального архива. Этот блок проверяет SHA-256 загруженного архива и поддерживает x86_64/aarch64:

```bash
(
set -euo pipefail
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo 'Нужна отдельная инструкция для этой архитектуры'; exit 1 ;;
esac
NODE_TMP=$(mktemp -d)
cd "$NODE_TMP"
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
NODE_ARCHIVE=$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v24.*-linux-" arch "[.]tar[.]xz$") {print $2; exit}' SHASUMS256.txt)
test -n "$NODE_ARCHIVE"
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$NODE_ARCHIVE"
awk -v name="$NODE_ARCHIVE" '$2 == name' SHASUMS256.txt | sha256sum -c -
sudo install -d /opt/node24
sudo tar -xJf "$NODE_ARCHIVE" -C /opt/node24 --strip-components=1
)
/opt/node24/bin/node --version
/opt/node24/bin/node -e "require('node:sqlite'); console.log('SQLite OK')"
```

Ожидается v24.12 или новее в ветке 24 и SQLite OK. Предупреждение ExperimentalWarning само по себе не означает ошибку. Архив и checksum получены по HTTPS с одного официального сайта; это проверка целостности, не независимая проверка подписи релиза.

## 3. Подготовить перенос на Windows

До финального снимка прекратите менять задачи в интерфейсе и ChatGPT. Остановите Windows-туннель и сделайте согласованную резервную копию штатной командой. Не копируйте работающий tasks.sqlite обычным Copy-Item: актуальные изменения могут находиться в WAL.

```powershell
Set-Location 'C:\path\to\vetvi'
npm run tunnel:stop
npm run backup -- ./backups/vdc-transfer.sqlite
tar -czf .local-tools/vetvi-source.tar.gz --exclude=node_modules --exclude=.git --exclude=.env --exclude=data --exclude=backups --exclude=.local-tools --exclude=.playwright-mcp --exclude=dist .
scp .local-tools/vetvi-source.tar.gz SSH_USER@SERVER_IP:~/vetvi-source.tar.gz
scp backups/vdc-transfer.sqlite SSH_USER@SERVER_IP:~/vetvi-transfer.sqlite
scp .local-tools/tunnel.env SSH_USER@SERVER_IP:~/vetvi-tunnel.env
```

Если vdc-transfer.sqlite уже существует, выберите новое имя и используйте его далее: штатная команда не перезаписывает резервные копии. Последний файл содержит секрет; передавайте его только через SSH, не отправляйте в чат. Не переносите Windows node_modules, бинарник .exe или старый YAML-профиль туннеля.

После снимка локальная база — только резервная копия. Не возобновляйте запись в неё: автоматической синхронизации Windows↔VDC нет.

## 4. Установить код и базу на Linux

На VDC, только при первой установке в подготовленные каталоги:

```bash
chmod 600 ~/vetvi-tunnel.env ~/vetvi-transfer.sqlite
sudo -u vetvi tar -xzf ~/vetvi-source.tar.gz -C /opt/vetvi --no-same-owner
sudo install -o vetvi -g vetvi -m 600 ~/vetvi-transfer.sqlite /var/lib/vetvi/data/tasks.sqlite
sudo install -o root -g vetvi -m 640 ~/vetvi-tunnel.env /etc/vetvi/tunnel.env
rm -- ~/vetvi-tunnel.env
cd /opt/vetvi
sudo -u vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm ci
sudo -u vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm test
sudo -u vetvi env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm run build
```

Не продолжайте при ошибках установки, тестов или сборки. Не используйте эту команду install для перезаписи уже работающей базы.

Создайте конфигурацию веб-приложения:

```bash
sudo install -o root -g vetvi -m 640 /dev/null /etc/vetvi/app.env
sudoedit /etc/vetvi/app.env
```

Содержимое; вместо CHANGE_ME поставьте собственный пароль минимум из 12 символов, желательно случайный из менеджера паролей. Для простоты используйте длинный буквенно-цифровой пароль без пробелов, кавычек и знаков shell:

```dotenv
NODE_ENV=production
OWNER_LOGIN=admin
OWNER_PASSWORD=CHANGE_ME
OWNER_SUBJECT=owner
HOST=127.0.0.1
PORT=3001
PUBLIC_BASE_URL=http://127.0.0.1:13001
UI_ORIGIN=http://127.0.0.1:13001
DATABASE_PATH=/var/lib/vetvi/data/tasks.sqlite
SEED_DEMO=false
```

OWNER_SUBJECT=owner сохраняет доступ к текущим записям; не заменяйте его логином или именем сервера. Файл /opt/vetvi/.env создавать не нужно: настройки передаёт systemd. OAuth-переменные для выбранного stdio-туннеля не нужны.

Создайте `sudoedit /etc/systemd/system/vetvi.service`:

```ini
[Unit]
Description=Vetvi web application
After=network.target

[Service]
User=vetvi
Group=vetvi
WorkingDirectory=/opt/vetvi
Environment=PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/vetvi/app.env
ExecStart=/opt/node24/bin/node --import tsx /opt/vetvi/server/index.ts
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/vetvi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vetvi
sudo systemctl status vetvi --no-pager
curl -fsS -H 'Host: 127.0.0.1:13001' http://127.0.0.1:3001/health
sudo sqlite3 -readonly /var/lib/vetvi/data/tasks.sqlite 'PRAGMA integrity_check;'
```

Ожидается active (running), {"ok":true} и ok.

## 5. Открыть интерфейс с компьютера

На Windows порт 3001 уже может занимать локальная копия. Не открывайте её по ошибке: используйте отдельный порт 13001. В PowerShell оставьте работающей команду:

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:13001:127.0.0.1:3001 -L 127.0.0.1:13002:127.0.0.1:3002 SSH_USER@SERVER_IP
```

Откройте http://127.0.0.1:13001. Пока этот SSH-сеанс открыт, браузер подключён к VDC. Приложение проверяет Host и Origin: адрес 13001 уже задан в PUBLIC_BASE_URL и UI_ORIGIN. Порт прослушивания PORT остаётся 3001. Другой локальный порт требует соответствующего изменения обеих переменных и перезапуска vetvi.

Проверка health на VDC после этой смены адреса:

```bash
curl -fsS -H 'Host: 127.0.0.1:13001' http://127.0.0.1:3001/health
```

Войдите как admin с паролем из /etc/vetvi/app.env. Проверьте свои проекты, активные задачи, сроки и историю по последнему Windows-снимку. Демонстрационные записи должны остаться в корзине.

## 6. Запустить Secure MCP Tunnel на VDC

В примерах замените `tunnel_YOUR_ID` на ID своего существующего туннеля. Используем тот же туннель и уже созданный ключ; новый ключ для переноса не нужен, если прежний действителен. Windows-клиент должен оставаться остановленным.

Скачайте Linux-клиент с https://github.com/openai/tunnel-client/releases/latest — архив tunnel-client для linux-amd64 или linux-arm64 под архитектуру VDC и SHA256SUMS.txt **того же релиза**. Сверьте архив через `sha256sum -c` по соответствующей строке SHA256SUMS.txt, распакуйте `unzip`, затем установите бинарник командой:

```bash
sudo install -m 755 /ПУТЬ/К/РАСПАКОВАННОМУ/tunnel-client /usr/local/bin/tunnel-client
/usr/local/bin/tunnel-client help quickstart
/usr/local/bin/tunnel-client init --help
```

Проверенная локально версия CLI — 0.0.18; более новая может отличаться. Берите полный официальный архив, сохраняйте companion-файлы рядом, если они присутствуют/требуются его quickstart. Не используйте Windows npm run tunnel:start на Linux: текущий scripts/tunnel.mjs явно ищет .exe.

Создайте отдельный Linux-профиль (секрет останется в env-файле):

```bash
sudo -u vetvi /usr/local/bin/tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile vetvi-vdc \
  --profile-dir /var/lib/vetvi/tunnel-profile \
  --tunnel-id tunnel_YOUR_ID \
  --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY \
  --mcp-command '/opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs /opt/vetvi/server/stdio.ts' \
  --health-listen-addr 127.0.0.1:3002
```

Создайте `sudoedit /etc/systemd/system/vetvi-tunnel.service`:

```ini
[Unit]
Description=Vetvi Secure MCP Tunnel
Wants=network-online.target
After=network-online.target

[Service]
User=vetvi
Group=vetvi
WorkingDirectory=/opt/vetvi
Environment=PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/var/lib/vetvi
EnvironmentFile=/etc/vetvi/app.env
EnvironmentFile=/etc/vetvi/tunnel.env
ExecStartPre=/usr/local/bin/tunnel-client doctor --profile vetvi-vdc --profile-dir /var/lib/vetvi/tunnel-profile --explain
ExecStart=/usr/local/bin/tunnel-client run --profile vetvi-vdc --profile-dir /var/lib/vetvi/tunnel-profile
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/vetvi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vetvi-tunnel
sudo systemctl status vetvi-tunnel --no-pager
curl -fsS http://127.0.0.1:3002/healthz
curl -fsS http://127.0.0.1:3002/readyz
```

Оба health endpoint должны отвечать успешно. В http://127.0.0.1:13002/ui через уже открытый SSH-проброс проверьте readiness и активный polling. Входящий доступ к OpenAI из интернета на VDC не нужен; нужен исходящий HTTPS. Прокси/корпоративный CA настраиваются по документации клиента, не отключением проверки TLS.

## 7. Проверить реальный доступ из ChatGPT и этого чата

Используйте свой существующий личный плагин ChatGPT. Он привязан к прежнему tunnel ID, поэтому сначала пробуйте его без пересоздания. При необходимости обновите список инструментов через интерфейс плагина. Если соединение создаётся заново: Add custom MCP server → Connection: Tunnel → указанный tunnel ID → No authentication для stdio-профиля → личный плагин в том же workspace. Пароль UI сюда не вводится.

В ChatGPT выберите этот плагин и отправьте:

> Используй MCP «Ветви». Вызови list_projects и search_tasks. Перечисли активные проекты и прочитай задачу «Регламент взаимодействия»: ID, статус, срок, приоритет, версия. Не изменяй реальные задачи. Если инструмент недоступен, сообщи об этом, не отвечай по истории чата.

Проверьте наличие **фактических вызовов инструментов**, а не только текстового ответа. Следом:

> Через MCP создай отдельную тестовую задачу «Проверка VDC — <текущая дата и время>» в отдельном тестовом проекте, со статусом planned. Сохрани возвращённый ID. Перечитай её, затем измени описание на «Записано через ChatGPT после переноса на VDC». Перечитай задачу и историю. Реальные задачи не меняй и ничего не завершай.

В браузере http://127.0.0.1:13001 обновите страницу, найдите именно этот ID/заголовок, новое описание и два события истории. При необходимости сравните запись непосредственно на VDC через sqlite3 в режиме readonly. Существование задачи только в ответе ChatGPT не является доказательством записи.

Обратная проверка: в интерфейсе VDC добавьте к описанию тестовой задачи «Изменено в интерфейсе VDC», затем попросите ChatGPT выполнить get_task по её ID и процитировать актуальное описание/версию. После проверки переместите только тестовую задачу в корзину, сохраните её историю.

Главная проверка независимости от Windows: закройте локальное приложение/оставьте Windows tunnel остановленным, повторите get_task из ChatGPT. Затем перезагрузите VDC в удобное время и повторите health, ready, вход и get_task. Автозапуск подтверждён только после этой проверки.

Подключение в веб-ChatGPT и наличие инструментов в текущем Codex-чате проверяются отдельно. После переноса напишите здесь: «VDC готов, туннель запущен; проверь list_projects и тестовую запись через подключённые Ветви». Я смогу подтвердить доступ только реальным вызовом доступного в этой сессии инструмента либо через авторизованную вкладку ChatGPT. Успешный curl на вашем сервере сам по себе не даёт мне SSH-доступ и не доказывает MCP-доступ в этом чате.

## 8. Резервные копии, обслуживание и откат

Снимок живой базы с проверкой целостности:

```bash
sudo -u vetvi env DATABASE_PATH=/var/lib/vetvi/data/tasks.sqlite \
  /opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs \
  /opt/vetvi/server/backup.ts \
  "/var/lib/vetvi/backups/tasks-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
```

Настройте выполнение этой команды ежедневно штатным планировщиком VDC и копирование резервных копий на другое защищённое хранилище; предложенная политика — 14 ежедневных копий. Резервные копии содержат личные задачи. В этой инструкции расписание и внешнее хранилище не создаются автоматически.

Команды диагностики:

```bash
sudo journalctl -u vetvi -n 50 --no-pager
sudo journalctl -u vetvi-tunnel -n 50 --no-pager
sudo systemctl restart vetvi
sudo systemctl restart vetvi-tunnel
sudo ss -ltnp | grep -E ':3001|:3002'
```

Порты должны слушать 127.0.0.1. При рестарте веб-сервера требуется повторный вход; задачи остаются в SQLite. За reverse proxy текущий лимит попыток входа общий для его адреса: после серии неверных паролей возможна блокировка входа на 15 минут.

Перед обновлением кода сделайте резервную копию, остановите обе службы, сохраните старый код и только затем заменяйте исходники/зависимости и пересобирайте. Секреты и /var/lib/vetvi/data остаются отдельно. Для восстановления не заменяйте SQLite под работающими службами. Сначала остановите обе службы и сохраните весь текущий каталог data, включая WAL/SHM; восстановите проверенный снимок в новый пустой каталог data с владельцем vetvi, затем запустите службы и повторите проверки.

Если перенос не удался до начала работы на VDC: остановите Linux-туннель и верните Windows-туннель командой npm run tunnel:start. Если на VDC уже появились изменения, старая Windows-база устарела: перед возвратом переносите свежую проверенную резервную копию с VDC. Автоматического слияния двух баз нет.

## 9. Если нужен постоянный адрес без SSH

Для https://tasks.ВАШ-ДОМЕН потребуются DNS, HTTPS reverse proxy (Nginx/Caddy), действительный сертификат и доступ браузера через VPN либо разрешённый ingress. Node оставьте на 127.0.0.1:3001. Установите PUBLIC_BASE_URL и UI_ORIGIN в одинаковый публичный HTTPS-origin; proxy обязан сохранить Host. Затем перезапустите vetvi. Пароль остаётся тем же; cookie станет Secure.

MCP продолжит работать через исходящий Secure MCP Tunnel независимо от публичности интерфейса. Прямой URL https://tasks.ВАШ-ДОМЕН/mcp сейчас **не заменяет** туннель: HTTP MCP требует отдельного OAuth-провайдера; веб-логин для него не подходит. Не выбирайте No authentication для публичного HTTP MCP.

Конфигурацию конкретного HTTPS-ingress стоит составить после выбора домена и схемы сети VDC; данное руководство полностью описывает первый закрытый запуск через SSH.

## Источники и границы проверки

- Код проекта: server/index.ts, server/auth.ts, server/stdio.ts, server/backup.ts, scripts/tunnel.mjs.
- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels): исходящий доступ, stdio, профили, диагностика, привязка workspace.
- [OpenAI: подключение и проверка плагина](https://developers.openai.com/plugins/deploy/connect-chatgpt).
- [Node.js: официальные загрузки](https://nodejs.org/en/download).
- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).
- [Nginx: proxy_set_header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

Сверены исходники и CLI help установленного tunnel-client 0.0.18. Linux-команды, systemd units, инфраструктура VDC, сетевой выход и работа MCP после переноса ещё не выполнялись и не подтверждены. Проверку Linux необходимо выполнить по шагам выше; текущие успешные локальные тесты её не заменяют.
