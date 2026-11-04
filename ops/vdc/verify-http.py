#!/usr/bin/env python3
"""Check the shared HTTP entry using read-only APIs and a short-lived UI session."""

import http.cookiejar
import json
import re
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPCookieProcessor,
    HTTPRedirectHandler,
    ProxyHandler,
    Request,
    build_opener,
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_platform(call):
    status, headers, _ = call("/")
    assert status == 302 and headers["Location"] in ("/platform", "/platform/"), (
        "platform redirect"
    )
    status, headers, body = call("/platform")
    if status == 200:
        assert b"Sign-in is not enabled" in body, "platform preview"
        assert "form-action 'none'" in headers["Content-Security-Policy"], (
            "platform CSP"
        )
        assert call("/platform/platform.css")[0] == 200, "platform stylesheet"
        assert call("/platform", "POST", {})[0] == 405, "platform method boundary"
        profile = "static"
    else:
        assert status == 302 and headers["Location"] == "/platform/", (
            "platform canonical route"
        )
        status, headers, body = call("/platform/auth/login")
        assert status == 200 and b"<form" in body and b'type="password"' in body, (
            "platform login page"
        )
        assert call("/platform/api/v1/projects")[0] == 401, (
            "platform API still requires its own session"
        )
        profile = "application"
    for path in ("/auth/login", "/workspace", "/api/v1/projects", "/metrics", "/docs"):
        assert call(path)[0] == 404, f"platform boundary: {path}"
    return profile


def verify(base, env_path):
    base = base.rstrip("/")
    address = urlsplit(base)
    origin = f"{address.scheme}://{address.netloc}"
    prefix = address.path
    # Use the application's dotenv parser; keep the credential JSON inside a private pipe.
    settings = json.loads(
        subprocess.check_output(
            [
                "/opt/node24/bin/node",
                "-e",
                "const env=require('node:util').parseEnv(require('node:fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify({OWNER_LOGIN:env.OWNER_LOGIN??'admin',OWNER_PASSWORD:env.OWNER_PASSWORD}))",
                str(env_path),
            ],
            text=True,
        )
    )
    cookies = http.cookiejar.CookieJar()
    client = build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(cookies))

    def call(path, method="GET", payload=None, headers=None):
        defaults = {"Content-Type": "application/json"}
        if method not in ("GET", "HEAD"):
            defaults["Origin"] = origin
        request = Request(
            origin + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={**defaults, **(headers or {})},
            method=method,
        )
        try:
            response = client.open(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    status, headers, _ = call(prefix)
    assert status == 308 and headers["Location"] == prefix + "/", "prefix redirect"
    status, headers, html = call(prefix + "/")
    assert status == 200 and "Ветви" in html.decode(), "Vetvi page"
    policies = headers.get_all("Content-Security-Policy") or []
    assert len(policies) == 1 and "form-action 'self'" in policies[0], "application CSP"
    assets = re.findall(r'(?:src|href)="([^"]+)"', html.decode())
    assert any(path.endswith(".js") for path in assets), "script asset"
    assert any(path.endswith(".css") for path in assets), "style asset"
    for path in assets:
        assert path.startswith(prefix + "/"), "asset escaped application prefix"
        status, headers, _ = call(path)
        assert status == 200, f"asset status: {path}"
        if path.endswith(".js"):
            assert "javascript" in headers["Content-Type"], "script MIME type"
        if path.endswith(".css"):
            assert "text/css" in headers["Content-Type"], "style MIME type"
    assert call(prefix + "/health")[0] == 200, "web health"
    assert call(prefix + "/health", headers={"Host": "invalid.example"})[0] == 403, (
        "Host rejection"
    )
    assert (
        call(prefix + "/health", headers={"Origin": "http://invalid.example"})[0] == 403
    ), "Origin rejection"
    assert call(prefix + "/api/tools/list_projects", "POST", {})[0] == 401, (
        "anonymous API"
    )
    assert (
        call(prefix + "/api/login", "POST", {}, {"Origin": "http://invalid.example"})[0]
        == 403
    ), "login CSRF"
    status, headers, body = call(prefix + "/.well-known/oauth-protected-resource/mcp")
    assert status == 200 and json.loads(body)["resource"] == base + "/mcp", (
        "MCP metadata prefix"
    )
    status, headers, _ = call(prefix + "/mcp", "POST", {})
    assert status == 401 and base + "/.well-known/" in headers["WWW-Authenticate"], (
        "MCP requires OAuth"
    )

    credentials = {
        "username": settings["OWNER_LOGIN"],
        "password": settings["OWNER_PASSWORD"],
    }
    status, headers, body = call(prefix + "/api/login", "POST", credentials)
    assert status == 200 and json.loads(body)["authenticated"], "owner login"
    session = next(cookie for cookie in cookies if cookie.name == "task_session")
    assert session.path == prefix and session.has_nonstandard_attr("HttpOnly"), (
        "session scope"
    )
    assert (
        not session.secure and session.get_nonstandard_attr("SameSite") == "Strict"
    ), "selected HTTP cookie policy"
    platform_request = Request(origin + "/platform")
    cookies.add_cookie_header(platform_request)
    assert platform_request.get_header("Cookie") is None, (
        "Vetvi cookie leaked to platform"
    )
    try:
        status, _, body = call(prefix + "/api/tools/list_projects", "POST", {})
        assert status == 200, "authenticated projects API"
        projects = json.loads(body)["total"]
        status, _, body = call(prefix + "/api/tools/search_tasks", "POST", {"limit": 1})
        assert status == 200, "authenticated tasks API"
        tasks = json.loads(body)["total"]
    finally:
        assert call(prefix + "/api/logout", "POST")[0] == 200, "logout"
    status, _, body = call(prefix + "/api/session")
    assert status == 200 and not json.loads(body)["authenticated"], "session revoked"
    assert call(prefix + "/api/tools/list_projects", "POST", {})[0] == 401, (
        "API after logout"
    )

    platform_profile = verify_platform(call)
    return {
        "result": "PASS",
        "url": base + "/",
        "projects": projects,
        "tasks": tasks,
        "prefixAssets": True,
        "scopedCookie": True,
        "hostOriginCsrf": True,
        "platformPreserved": True,
        "platformProfile": platform_profile,
        "mutatedTasks": 0,
    }


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1], sys.argv[2]), ensure_ascii=False, indent=2))
