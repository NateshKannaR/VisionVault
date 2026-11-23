"""Exercise HTTP, authentication, privacy budget, and streaming through a real Uvicorn process."""

import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PlannerHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.token = secrets.token_urlsafe(32)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        env = {
            **os.environ,
            "VISIONVAULT_API_TOKEN": cls.token,
            "VISIONVAULT_ALLOWED_ORIGINS": "https://workspace.example.test",
            "OLLAMA_HOST": "",
            "OPENROUTER_API_KEY": "",
            "GEMINI_API_KEY": "",
        }
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--app-dir", "server",
             "--host", "127.0.0.1", "--port", str(cls.port), "--no-access-log",
             "--no-proxy-headers"],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        cls.addClassCleanup(cls.stop_server)
        for _ in range(100):
            if cls.proc.poll() is not None:
                raise RuntimeError(cls.proc.stdout.read())
            try:
                if cls.request("GET", "/livez", authenticated=False)[0] == 200:
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("Planner did not start")

    @classmethod
    def stop_server(cls):
        cls.proc.terminate()
        try:
            cls.proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.communicate(timeout=10)

    @classmethod
    def request(cls, method, route, payload=None, *, authenticated=True, headers=None, chunked=False):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=5)
        all_headers = {"Authorization": "Bearer " + cls.token} if authenticated else {}
        if payload is not None:
            all_headers["Content-Type"] = "application/json"
        all_headers.update(headers or {})
        try:
            body = payload if chunked else (json.dumps(payload).encode() if payload is not None else None)
            connection.request(method, route, body, all_headers, encode_chunked=chunked)
            response = connection.getresponse()
            return response.status, {name.lower(): value for name, value in response.getheaders()}, response.read()
        finally:
            connection.close()

    def test_routes_and_bearer_token(self):
        for method, route in [("GET", "/health"), ("POST", "/api/agent/plan"),
                              ("POST", "/api/agent/step"), ("POST", "/api/agent/step/stream"),
                              ("POST", "/plan-action")]:
            with self.subTest(route=route):
                status, headers, _ = self.request(method, route, authenticated=False)
                self.assertEqual(status, 401)
                self.assertEqual(headers["www-authenticate"], "Bearer")
        self.assertEqual(self.request("GET", "/health")[0], 200)
        self.assertEqual(self.request("GET", "/health", headers={"Authorization": "Bearer invalid"})[0], 401)

    def test_planner_stream_matches_json(self):
        payload = {"task": "search for optics", "marks": [{"id": 2, "role": "input:search", "label": "search"}]}
        step = self.request("POST", "/api/agent/step", payload)
        legacy = self.request("POST", "/plan-action", payload)
        stream = self.request("POST", "/api/agent/step/stream", payload)
        self.assertEqual((step[0], legacy[0], stream[0]), (200, 200, 200))
        self.assertEqual(json.loads(step[2]), json.loads(legacy[2]))
        self.assertIn("text/event-stream", stream[1]["content-type"])
        events = [line[6:] for line in stream[2].decode().splitlines() if line.startswith("data: ")]
        self.assertEqual(events[-1], "[DONE]")
        result = json.loads(events[-2])
        self.assertFalse(result.pop("partial"))
        self.assertEqual(result, json.loads(step[2]))

    def test_request_policy(self):
        route = "/api/agent/step"
        payload = {"task": "fixture task", "privacy_budget": {"level": 0}, "redactedImage": "fixture"}
        status, _, body = self.request("POST", route, payload)
        self.assertEqual(status, 422)
        self.assertNotIn(b"fixture", body)
        self.assertEqual(self.request("POST", route, {}, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", route, headers={
            "Content-Length": str(13 * 1024 * 1024), "Content-Type": "application/json",
        })[0], 413)
        self.assertEqual(self.request("POST", route, [b" " * (1024 * 1024)] * 13, chunked=True)[0], 413)

    def test_explicit_cors(self):
        for origin, expected in [("https://workspace.example.test", 200), ("https://other.example.test", 400)]:
            status, _, _ = self.request("OPTIONS", "/api/agent/plan", authenticated=False, headers={
                "Origin": origin, "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            })
            self.assertEqual(status, expected)


if __name__ == "__main__":
    unittest.main()
