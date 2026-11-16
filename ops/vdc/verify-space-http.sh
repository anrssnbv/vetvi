#!/usr/bin/env bash
# Anonymous HTTP surface of the shared Space entry when the app runs in the
# delegation-only SK AI mode (SK_AI_SOCKET_PATH set). The OAuth metadata and
# owner-cookie checks in verify-http.py belong to the standalone HTTP mode.
set -euo pipefail
umask 0077
VDC_BASE=${1:-http://92.46.191.252}
path=/space
prefix="$VDC_BASE$path"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() {
  echo "Проверка не пройдена: $1" >&2
  exit 1
}
code() {
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$@"
}

read -r status target < <(curl -sS --max-time 10 -o /dev/null \
  -w '%{http_code} %{redirect_url}\n' "$prefix")
[[ $status == 308 && $target == "$prefix/" ]] || fail "редирект префикса: $status $target"
status=$(curl -sS --max-time 10 -D "$work/headers" -o "$work/index.html" \
  -w '%{http_code}' "$prefix/")
[[ $status == 200 ]] || fail "страница приложения: $status"
grep -q '<title>Space</title>' "$work/index.html" || fail 'заголовок приложения'
tr -d '\r' < "$work/headers" | grep -qi "^Content-Security-Policy: .*form-action 'self'" \
  || fail 'CSP приложения'
for asset in $(grep -o '[a-z]*="[^"]*\.\(js\|css\)"' "$work/index.html" | cut -d'"' -f2); do
  [[ $asset == "$path/"* ]] || fail "ресурс вне префикса: $asset"
  type=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{content_type}' \
    "${VDC_BASE}${asset}")
  case $asset in
    *.js) [[ $type == "200 "*javascript* ]] || fail "сценарий: $type" ;;
    *.css) [[ $type == "200 "*text/css* ]] || fail "стиль: $type" ;;
  esac
done
[[ $(code "$prefix/health") == 200 ]] || fail 'health'
[[ $(code -H 'Host: invalid.example' "$prefix/health") == 403 ]] || fail 'отказ по Host'
[[ $(code -H 'Origin: http://invalid.example' "$prefix/health") == 403 ]] || fail 'отказ по Origin'
[[ $(code -X POST -H 'Content-Type: application/json' -H "Origin: $VDC_BASE" -d '{}' \
  "$prefix/api/tools/list_projects") == 401 ]] || fail 'анонимный API'
[[ $(code -X POST -H 'Content-Type: application/json' -H 'Origin: http://invalid.example' \
  -d '{}' "$prefix/api/login") == 403 ]] || fail 'CSRF входа'
delegated=$(curl -sS --max-time 10 -w $'\n%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $VDC_BASE" -d '{}' "$prefix/mcp")
[[ $(tail -n1 <<<"$delegated") == 403 ]] || fail 'MCP в режиме делегации'
grep -q INDIVIDUAL_DELEGATION_REQUIRED <<<"$delegated" || fail 'MCP в режиме делегации: тело'
printf '{"result":"PASS","mode":"delegation-only","prefix":"%s"}\n' "$prefix"