#!/usr/bin/env bash
set -euo pipefail
umask 0077
if (( EUID != 0 )); then
  echo 'Запустите этот файл через sudo bash.' >&2
  exit 1
fi
VDC_WORKSPACE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
VDC_ASSETS="$VDC_WORKSPACE/.local-tools/vdc"
VDC_OPERATOR=/home/admin-srv/.config/sk-ai-platform
VDC_PLATFORM_DIR=/home/admin-srv/sk-ai-project-platform/infra
VDC_PYTHON=/home/admin-srv/.local/share/sk-ai-devtools/spec13/venv/bin/python
VDC_COMPOSE=(docker --host unix:///var/run/docker.sock compose --project-directory "$VDC_PLATFORM_DIR" --env-file "$VDC_OPERATOR/runtime.env" -f "$VDC_OPERATOR/compose.yaml")
VDC_CHANGED=false
VDC_BACKUP=""
VDC_PHASE=preflight
VDC_LOG="$VDC_ASSETS/apply-http.log"
test ! -L "$VDC_LOG"
touch "$VDC_LOG"
chown admin-srv:admin-srv "$VDC_LOG"
chmod 600 "$VDC_LOG"
exec > >(tee -a "$VDC_LOG") 2>&1
echo "Журнал: $VDC_LOG"
on_error() {
  local status=$?
  trap - ERR
  printf 'Ошибка этапа %s: строка %s, код %s.\n' "$VDC_PHASE" "${BASH_LINENO[0]}" "$status" >&2
  if "$VDC_CHANGED"; then
    echo 'Восстанавливаю прежние код/env и конфигурацию gateway; базы не заменяются.' >&2
    bash "$VDC_WORKSPACE/ops/vdc/rollback-http.sh" "$VDC_BACKUP" || echo "Автооткат не завершён; каталог восстановления: $VDC_BACKUP" >&2
  fi
  exit "$status"
}
trap on_error ERR

# runuser сохраняет cwd; tsx/esbuild нужен доступный сервисному пользователю каталог.
cd /opt/vetvi
test -f "$VDC_OPERATOR/operator.lock"
exec {VDC_OPERATOR_LOCK}>>"$VDC_OPERATOR/operator.lock"
flock -n "$VDC_OPERATOR_LOCK"
VDC_CONTAINER=$(docker ps -q --filter label=com.docker.compose.project=sk-ai-public-http --filter label=com.docker.compose.service=nginx)
[[ "$VDC_CONTAINER" =~ ^[a-f0-9]{12}$ ]]
test "$(docker inspect --format '{{.Config.User}}' "$VDC_CONTAINER")" = 1000:1000
test "$(docker inspect --format '{{.Config.Image}}' "$VDC_CONTAINER")" = sk-ai-http-login:spec18
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$VDC_CONTAINER")" = "$VDC_OPERATOR/compose.yaml"
test "$(docker exec "$VDC_CONTAINER" cat /etc/nginx/nginx.conf | sha256sum | cut -d ' ' -f 1)" = 64496903910788c85a2b37941acf496339c171e5bf670122da0517013dcb7a3c
docker exec "$VDC_CONTAINER" nginx -t
"${VDC_COMPOSE[@]}" config --quiet
curl -fsS -H 'Host: 127.0.0.1:13001' http://127.0.0.1:3001/health >/dev/null
for path in /etc/systemd/system/vetvi-proxy.socket /etc/systemd/system/vetvi-proxy.service /opt/vetvi/server/subpath.test.ts; do
  test ! -e "$path"
done
sha256sum -c "$VDC_ASSETS/http-original-files.sha256"
(cd "$VDC_ASSETS" && sha256sum -c http-release.sha256)

VDC_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
VDC_BACKUP="/var/lib/vetvi/deployments/http-$VDC_STAMP"
install -d -o root -g root -m 700 /var/lib/vetvi/deployments "$VDC_BACKUP"
docker inspect --format '{{.Image}}' "$VDC_CONTAINER" > "$VDC_BACKUP/nginx-image"
docker exec "$VDC_CONTAINER" nginx -T > "$VDC_BACKUP/nginx-before.txt" 2>&1
docker ps --filter label=com.docker.compose.project=sk-ai-public-http --format '{{.Label "com.docker.compose.service"}} {{.ID}}' | awk '$1 != "nginx"' | LC_ALL=C sort > "$VDC_BACKUP/backends-before.txt"
install -o root -g root -m 600 "$VDC_OPERATOR/compose.yaml" "$VDC_BACKUP/platform-compose.yaml"
install -o root -g root -m 600 /etc/vetvi/app.env "$VDC_BACKUP/app.env"
tar -czf "$VDC_BACKUP/code.tar.gz" -C /opt/vetvi \
  server/auth.ts server/index.ts src/App.tsx index.html .env.example eslint.config.js dist
VDC_PHASE=sqlite-backup
runuser -u vetvi -- env DATABASE_PATH=/var/lib/vetvi/data/tasks.sqlite \
  /opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs /opt/vetvi/server/backup.ts \
  "/var/lib/vetvi/backups/pre-http-$VDC_STAMP.sqlite"
install -o root -g root -m 600 "$VDC_BACKUP/platform-compose.yaml" "$VDC_BACKUP/platform-compose-with-vetvi.yaml"
"$VDC_PYTHON" "$VDC_WORKSPACE/ops/vdc/set-nginx-socket.py" "$VDC_BACKUP/platform-compose-with-vetvi.yaml"
docker --host unix:///var/run/docker.sock compose --project-directory "$VDC_PLATFORM_DIR" --env-file "$VDC_OPERATOR/runtime.env" -f "$VDC_BACKUP/platform-compose-with-vetvi.yaml" config --quiet

VDC_PHASE=vetvi-update
VDC_CHANGED=true
systemctl stop vetvi vetvi-tunnel
runuser -u vetvi -- tar -xzf - -C /opt/vetvi --no-same-owner < "$VDC_ASSETS/http-release.tar.gz"
grep -q '^PUBLIC_BASE_URL=' /etc/vetvi/app.env
grep -q '^UI_ORIGIN=' /etc/vetvi/app.env
sed -i \
  -e 's@^PUBLIC_BASE_URL=.*@PUBLIC_BASE_URL=http://92.46.191.252/vetvi/@' \
  -e 's@^UI_ORIGIN=.*@UI_ORIGIN=http://92.46.191.252@' \
  -e '/^ALLOW_INSECURE_HTTP=/d' /etc/vetvi/app.env
printf '\nALLOW_INSECURE_HTTP=true\n' >> /etc/vetvi/app.env
chown root:vetvi /etc/vetvi/app.env
chmod 640 /etc/vetvi/app.env
runuser -u vetvi -- env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm test
runuser -u vetvi -- env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm run build -- --base=/vetvi/
for name in vetvi-proxy.socket vetvi-proxy.service; do
  install -o root -g root -m 644 "$VDC_WORKSPACE/ops/vdc/$name" "/etc/systemd/system/$name"
done
systemd-analyze verify /etc/systemd/system/vetvi-proxy.socket /etc/systemd/system/vetvi-proxy.service
systemctl daemon-reload
systemctl start vetvi vetvi-tunnel
systemctl enable --now vetvi-proxy.socket
curl -fsS --retry 5 --retry-connrefused --max-time 5 -H 'Host: 92.46.191.252' http://127.0.0.1:3001/health
(cd / && runuser -u admin-srv -- curl -fsS --retry 5 --retry-connrefused --max-time 5 --unix-socket /run/vetvi-proxy/http.sock -H 'Host: 92.46.191.252' http://localhost/health)

VDC_PHASE=gateway-socket-mount
install -o admin-srv -g admin-srv -m 600 "$VDC_BACKUP/platform-compose-with-vetvi.yaml" "$VDC_OPERATOR/compose.yaml"
"${VDC_COMPOSE[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 60 nginx
VDC_CONTAINER=$(docker ps -q --filter label=com.docker.compose.project=sk-ai-public-http --filter label=com.docker.compose.service=nginx)
test "$(docker inspect --format '{{.Image}}' "$VDC_CONTAINER")" = "$(cat "$VDC_BACKUP/nginx-image")"
docker ps --filter label=com.docker.compose.project=sk-ai-public-http --format '{{.Label "com.docker.compose.service"}} {{.ID}}' | awk '$1 != "nginx"' | LC_ALL=C sort | cmp - "$VDC_BACKUP/backends-before.txt"
VDC_PHASE=http-acceptance
python3 "$VDC_WORKSPACE/ops/vdc/verify-http.py" http://92.46.191.252/vetvi/ /etc/vetvi/app.env
curl -fsS http://127.0.0.1:3002/readyz
systemctl is-active vetvi vetvi-tunnel vetvi-proxy.socket
printf 'HTTP применён: http://92.46.191.252/vetvi/\nКаталог отката: %s\n' "$VDC_BACKUP"
trap - ERR
if ! systemctl is-enabled --quiet vetvi-backup.timer; then
  if [[ ! -e /etc/systemd/system/vetvi-backup.service && ! -e /etc/systemd/system/vetvi-backup.timer ]]; then
    bash "$VDC_WORKSPACE/ops/vdc/install-backup.sh"
  else
    systemctl start vetvi-backup.service
    systemctl enable --now vetvi-backup.timer
  fi
fi
echo 'HTTP не шифрует пароль и cookie. MCP остаётся в приватном туннеле.'
