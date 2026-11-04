#!/usr/bin/env bash
set -euo pipefail
umask 0077
if (( EUID != 0 )); then
  echo 'Запустите этот файл через sudo bash.' >&2
  exit 1
fi
VDC_BACKUP=${1:?Укажите каталог отката, выведенный установщиком}
VDC_OPERATOR=/home/admin-srv/.config/sk-ai-platform
VDC_PLATFORM_DIR=/home/admin-srv/sk-ai-project-platform/infra
test "$(stat -c %U "$VDC_BACKUP")" = root
for file in code.tar.gz app.env nginx-image platform-compose.yaml; do
  test -f "$VDC_BACKUP/$file"
done
VDC_OLD_IMAGE=$(cat "$VDC_BACKUP/nginx-image")
[[ "$VDC_OLD_IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]]
cd /opt/vetvi
systemctl stop vetvi vetvi-tunnel
systemctl disable --now vetvi-proxy.socket 2>/dev/null || true
systemctl stop vetvi-proxy.service 2>/dev/null || true
runuser -u vetvi -- tar -xzf - -C /opt/vetvi --no-same-owner < "$VDC_BACKUP/code.tar.gz"
rm -f -- /opt/vetvi/server/subpath.test.ts
install -o root -g vetvi -m 640 "$VDC_BACKUP/app.env" /etc/vetvi/app.env
install -o admin-srv -g admin-srv -m 600 "$VDC_BACKUP/platform-compose.yaml" "$VDC_OPERATOR/compose.yaml"
rm -f -- /etc/systemd/system/vetvi-proxy.socket /etc/systemd/system/vetvi-proxy.service
systemctl daemon-reload
systemctl start vetvi vetvi-tunnel
printf 'services:\n  nginx:\n    image: %s\n' "$VDC_OLD_IMAGE" > "$VDC_BACKUP/nginx-rollback.yaml"
docker --host unix:///var/run/docker.sock compose --project-directory "$VDC_PLATFORM_DIR" --env-file "$VDC_OPERATOR/runtime.env" \
  -f "$VDC_OPERATOR/compose.yaml" -f "$VDC_BACKUP/nginx-rollback.yaml" \
  up -d --no-deps --no-build --pull never --wait --wait-timeout 60 nginx
curl -fsS --retry 5 --retry-connrefused --max-time 5 -H 'Host: 127.0.0.1:13001' http://127.0.0.1:3001/health
echo 'Код/env Ветвей и прежняя конфигурация gateway восстановлены. Базы Ветвей и платформы не заменялись.'
