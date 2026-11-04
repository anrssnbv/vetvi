#!/usr/bin/env bash
set -euo pipefail
umask 0077

if (( EUID != 0 )); then
  echo 'Запустите этот файл через sudo bash.' >&2
  exit 1
fi

: "${VDC_TUNNEL_ID:?Задайте ID своего туннеля в VDC_TUNNEL_ID}"

VDC_WORKSPACE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
VDC_INPUT=/home/admin-srv
VDC_CONFIG="$VDC_WORKSPACE/.local-tools/vdc"

# Повторный запуск не должен затереть установленный код, базу или настройки.
for path in /opt/vetvi/package.json /var/lib/vetvi/data/tasks.sqlite /etc/vetvi/app.env /etc/vetvi/tunnel.env /etc/systemd/system/vetvi.service /etc/systemd/system/vetvi-tunnel.service; do
  if [[ -e "$path" || -L "$path" ]]; then
    echo "Уже существует; установка остановлена без перезаписи: $path" >&2
    exit 1
  fi
done
test -z "$(find /opt/vetvi -mindepth 1 -maxdepth 1 -print -quit)"
test -z "$(find /var/lib/vetvi/data -mindepth 1 -maxdepth 1 -print -quit)"
test -z "$(find /var/lib/vetvi/tunnel-profile -mindepth 1 -maxdepth 1 -print -quit)"
test -r "$VDC_CONFIG/app.env"
test -r "$VDC_CONFIG/tunnel.env"

cd "$VDC_INPUT"
sha256sum -c <<'CHECKSUMS'
5b80e73ed9783d40fc79f14bac913cd2444d61967430049d456225f7381e1d29  vetvi-source.tar.gz
623b02ef5f38fdac43757d3b8b3c5d51c5552716cec16a45b1c5f3429a1dc184  vetvi-transfer.sqlite
CHECKSUMS
test "$(sqlite3 -readonly "$VDC_INPUT/vetvi-transfer.sqlite" 'PRAGMA integrity_check;')" = ok

runuser -u vetvi -- tar -xzf - -C /opt/vetvi --no-same-owner < "$VDC_INPUT/vetvi-source.tar.gz"
cd /opt/vetvi
runuser -u vetvi -- env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm ci --include=dev --no-fund --no-audit
runuser -u vetvi -- env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm test
runuser -u vetvi -- env PATH=/opt/node24/bin:/usr/bin:/bin /opt/node24/bin/npm run build

install -o vetvi -g vetvi -m 600 "$VDC_INPUT/vetvi-transfer.sqlite" /var/lib/vetvi/data/tasks.sqlite
install -o vetvi -g vetvi -m 600 "$VDC_INPUT/vetvi-transfer.sqlite" "/var/lib/vetvi/backups/transfer-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
install -o root -g vetvi -m 640 "$VDC_CONFIG/app.env" /etc/vetvi/app.env
install -o root -g vetvi -m 640 "$VDC_CONFIG/tunnel.env" /etc/vetvi/tunnel.env
install -o root -g root -m 644 "$VDC_WORKSPACE/ops/vdc/vetvi.service" /etc/systemd/system/vetvi.service
install -o root -g root -m 644 "$VDC_WORKSPACE/ops/vdc/vetvi-tunnel.service" /etc/systemd/system/vetvi-tunnel.service

runuser -u vetvi -- /usr/local/bin/tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile vetvi-vdc \
  --profile-dir /var/lib/vetvi/tunnel-profile \
  --tunnel-id "$VDC_TUNNEL_ID" \
  --control-plane-api-key-ref env:CONTROL_PLANE_API_KEY \
  --mcp-command '/opt/node24/bin/node --import /opt/vetvi/node_modules/tsx/dist/loader.mjs /opt/vetvi/server/stdio.ts' \
  --health-listen-addr 127.0.0.1:3002

systemd-analyze verify /etc/systemd/system/vetvi.service /etc/systemd/system/vetvi-tunnel.service
systemctl daemon-reload
systemctl enable --now vetvi
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 \
  -H 'Host: 127.0.0.1:13001' http://127.0.0.1:3001/health
systemctl enable --now vetvi-tunnel
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:3002/healthz
curl -fsS --retry 10 --retry-all-errors --retry-delay 1 --max-time 5 http://127.0.0.1:3002/readyz
systemctl is-active vetvi vetvi-tunnel
echo 'Службы запущены. Веб-вход, реальные вызовы MCP и перезагрузка проверяются отдельно.'
echo "Логин admin; пароль находится в защищённом файле $VDC_CONFIG/app.env (OWNER_PASSWORD)."
