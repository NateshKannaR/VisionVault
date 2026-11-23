"""Request policy for the planner API."""

import hmac
from ipaddress import ip_address

from starlette.datastructures import Headers
from starlette.responses import JSONResponse

PLANNER_PATHS = {"/api/agent/plan", "/api/agent/step", "/api/agent/step/stream", "/plan-action"}
MAX_REQUEST_BYTES = 12 * 1024 * 1024


class PlannerPolicy:
    def __init__(self, app, *, token: str):
        self.app = app
        self.authorization = f"Bearer {token}".encode() if token else None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] == "OPTIONS":
            return await self.app(scope, receive, send)

        path = scope["path"].rstrip("/")
        is_plan = path in PLANNER_PATHS
        if not is_plan and path != "/health":
            return await self.app(scope, receive, send)

        headers = Headers(scope=scope)
        if self.authorization:
            supplied = headers.get("authorization", "").encode()
            if not hmac.compare_digest(supplied, self.authorization):
                return await JSONResponse(
                    {"detail": "Planner token required"}, 401,
                    headers={"WWW-Authenticate": "Bearer"},
                )(scope, receive, send)
        else:
            client = scope.get("client")
            try:
                local = client and ip_address(client[0]).is_loopback
            except ValueError:
                local = False
            if not local:
                return await JSONResponse({"detail": "Configure a planner token for remote access"}, 403)(
                    scope, receive, send,
                )

        if not is_plan or scope["method"] != "POST":
            return await self.app(scope, receive, send)

        if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            return await JSONResponse({"detail": "Expected application/json"}, 415)(scope, receive, send)

        declared_size = headers.get("content-length")
        if declared_size is not None:
            try:
                size = int(declared_size)
                if size < 0:
                    raise ValueError
            except ValueError:
                return await JSONResponse({"detail": "Invalid Content-Length"}, 400)(scope, receive, send)
            if size > MAX_REQUEST_BYTES:
                return await JSONResponse({"detail": "Planner request exceeds 12 MiB"}, 413)(scope, receive, send)

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                return await JSONResponse({"detail": "Planner request exceeds 12 MiB"}, 413)(scope, receive, send)
            body.extend(chunk)
            if not message.get("more_body"):
                break

        async def replay():
            nonlocal body
            if body is None:
                return await receive()
            result = {"type": "http.request", "body": bytes(body), "more_body": False}
            body = None
            return result

        await self.app(scope, replay, send)
