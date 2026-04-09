"""
Antigravity Traffic Capture - mitmproxy addon
==============================================
Captures and pretty-prints traffic between Antigravity and Cloud Code APIs.

Usage:
  npm run capture:start   # switches system proxy to mitmdump, upstream to Clash
  npm run capture:stop    # restores system proxy to Clash
  npm run capture:status  # check current state

Logs are saved to: antigravity_traffic.log (same directory)
"""

import gzip
import json
import os
import re
import time
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from mitmproxy import http

# ============================================================
# Configuration
# ============================================================

TARGET_DOMAINS = [
    "daily-cloudcode-pa.sandbox.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
]

HIGHLIGHT_PATHS = [
    "tabChat",
    "streamGenerateContent",
    "generateContent",
    "loadCodeAssist",
    "fetchAvailableModels",
    "onboardUser",
    "fetchUserInfo",
    "token",
]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "antigravity_traffic.log")
JSON_LOG_DIR = os.path.join(SCRIPT_DIR, "traffic_dumps")

SENSITIVE_HEADER_NAMES = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-goog-api-key",
    "x-api-key",
}

SENSITIVE_QUERY_KEYS = {
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "code",
    "key",
    "api_key",
    "secret",
}

SENSITIVE_JSON_KEYS = {
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "authorization",
    "api_key",
    "key",
    "secret",
    "password",
    "proxy",
    "http_proxy",
    "https_proxy",
    "proxy_url",
}

# These fields are token counts / output budgets, not credentials. Keep them
# visible so Cloud Code payloads can be compared against official Antigravity
# traffic without leaking secrets.
SAFE_TOKEN_JSON_KEYS = {
    "maxoutputtokens",
    "prompttokencount",
    "candidatestokencount",
    "cachedcontenttokencount",
    "toolusetokencount",
    "thoughtstokencount",
    "totaltokencount",
}

RAW_REDACTION_PATTERNS = [
    (
        re.compile(r"(?i)(authorization\"?\s*[:=]\s*\"?bearer\s+)([^\"\\\s]+)"),
        r"\1<redacted>",
    ),
    (
        re.compile(
            r"(?i)(\"?(?:access_token|refresh_token|id_token|api_key|secret|password|proxy_url|http_proxy|https_proxy)\"?\s*[:=]\s*\"?)([^\"\\\n]+)"
        ),
        r"\1<redacted>",
    ),
]


class Colors:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    BG_RED = "\033[41m"


class AntigravityCapture:
    def __init__(self):
        self.request_count = 0
        self.start_time = time.time()

        os.makedirs(JSON_LOG_DIR, mode=0o700, exist_ok=True)
        self._secure_path(JSON_LOG_DIR, is_dir=True)

        with open(LOG_FILE, "w", encoding="utf-8") as f:
            f.write("# Antigravity Traffic Capture Log\n")
            f.write(f"# Started: {datetime.now().isoformat()}\n")
            f.write(f"# {'=' * 70}\n\n")
        self._secure_path(LOG_FILE)

        self._print_banner()

    def _print_banner(self):
        print(f"\n{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}")
        print(
            f"{Colors.BOLD}{Colors.CYAN}  Antigravity Traffic Capture{Colors.RESET}"
        )
        print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}")
        print(f"{Colors.DIM}  Monitoring: {', '.join(TARGET_DOMAINS)}{Colors.RESET}")
        print(f"{Colors.DIM}  Log file:   {LOG_FILE}{Colors.RESET}")
        print(f"{Colors.DIM}  Dumps dir:  {JSON_LOG_DIR}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}\n")

    def _is_target(self, flow: http.HTTPFlow) -> bool:
        host = flow.request.pretty_host
        return any(domain in host for domain in TARGET_DOMAINS)

    def _get_path_label(self, path: str) -> str:
        for p in HIGHLIGHT_PATHS:
            if p in path:
                return p
        return path.split("/")[-1] if "/" in path else path

    def _decode_body(self, raw: bytes, headers: dict) -> str:
        if not raw:
            return ""
        try:
            content_encoding = headers.get("content-encoding", "")
            if "gzip" in content_encoding:
                raw = gzip.decompress(raw)
            return raw.decode("utf-8", errors="replace")
        except Exception:
            return raw.decode("utf-8", errors="replace")

    def _truncate(self, text: str, max_len: int = 500) -> str:
        if len(text) <= max_len:
            return text
        return text[:max_len] + f"... ({len(text)} bytes total)"

    def _format_json(self, text: str, indent: int = 2) -> str:
        try:
            obj = json.loads(text)
            return json.dumps(obj, indent=indent, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            return text

    def _secure_path(self, path: str, is_dir: bool = False):
        try:
            os.chmod(path, 0o700 if is_dir else 0o600)
        except OSError:
            pass

    def _is_sensitive_key(self, key: str) -> bool:
        normalized = key.strip().lower()
        compact = re.sub(r"[^a-z0-9]", "", normalized)
        if compact in SAFE_TOKEN_JSON_KEYS:
            return False
        if normalized in SENSITIVE_JSON_KEYS:
            return True
        return (
            "token" in normalized
            or "secret" in normalized
            or "password" in normalized
            or normalized.endswith("_key")
            or normalized.endswith("_proxy")
        )

    def _sanitize_url(self, url: str) -> str:
        try:
            parts = urlsplit(url)
            if not parts.query:
                return url

            redacted_query = []
            for key, value in parse_qsl(parts.query, keep_blank_values=True):
                normalized = key.strip().lower()
                if normalized in SENSITIVE_QUERY_KEYS or self._is_sensitive_key(key):
                    redacted_query.append((key, "<redacted>"))
                else:
                    redacted_query.append((key, value))

            return urlunsplit(
                (
                    parts.scheme,
                    parts.netloc,
                    parts.path,
                    urlencode(redacted_query, doseq=True),
                    parts.fragment,
                )
            )
        except Exception:
            return url

    def _sanitize_headers(self, headers: dict) -> dict:
        sanitized = {}
        for key, value in headers.items():
            normalized = key.strip().lower()
            if normalized in SENSITIVE_HEADER_NAMES or self._is_sensitive_key(key):
                if normalized == "authorization" and isinstance(value, str):
                    scheme = value.split(" ", 1)[0] if value else "Bearer"
                    sanitized[key] = f"{scheme} <redacted>"
                else:
                    sanitized[key] = "<redacted>"
            else:
                sanitized[key] = value
        return sanitized

    def _sanitize_json_value(self, value):
        if isinstance(value, dict):
            sanitized = {}
            for key, item in value.items():
                if self._is_sensitive_key(str(key)):
                    sanitized[key] = "<redacted>"
                else:
                    sanitized[key] = self._sanitize_json_value(item)
            return sanitized
        if isinstance(value, list):
            return [self._sanitize_json_value(item) for item in value]
        return value

    def _sanitize_raw_text(self, text: str) -> str:
        sanitized = text
        for pattern, replacement in RAW_REDACTION_PATTERNS:
            sanitized = pattern.sub(replacement, sanitized)
        return sanitized

    def _sanitize_body_payload(self, text: str):
        if not text:
            return None
        try:
            return self._sanitize_json_value(json.loads(text))
        except (json.JSONDecodeError, TypeError):
            return self._sanitize_raw_text(text)

    def _serialize_for_log(self, value) -> str:
        if isinstance(value, (dict, list)):
            return json.dumps(value, indent=2, ensure_ascii=False)
        return value or ""

    def _extract_key_info(self, body_text: str) -> dict:
        info = {}
        try:
            obj = json.loads(body_text)

            if "model" in obj:
                info["model"] = obj["model"]
            if "project" in obj:
                info["project"] = obj["project"]
            if "requestType" in obj:
                info["requestType"] = obj["requestType"]
            if "userAgent" in obj:
                info["userAgent"] = obj["userAgent"]

            req = obj.get("request", {})
            if "contents" in req:
                contents = req["contents"]
                if contents and len(contents) > 0:
                    last_msg = contents[-1]
                    role = last_msg.get("role", "?")
                    parts = last_msg.get("parts", [])
                    text_parts = [p.get("text", "") for p in parts if "text" in p]
                    if text_parts:
                        last_text = text_parts[-1]
                        info["last_message"] = f"[{role}] {last_text[:100]}"
                    func_calls = [p for p in parts if "functionCall" in p]
                    if func_calls:
                        info["tool_calls"] = [
                            p["functionCall"].get("name", "?") for p in func_calls
                        ]
                info["message_count"] = len(contents)

            gen_config = req.get("generationConfig", {})
            if gen_config:
                info["maxOutputTokens"] = gen_config.get("maxOutputTokens")
                thinking = gen_config.get("thinkingConfig", {})
                if thinking:
                    info["thinking"] = thinking.get("includeThoughts", False)

            if "response" in obj:
                resp = obj["response"]
                candidates = resp.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    text_parts = [
                        p.get("text", "")
                        for p in parts
                        if "text" in p and not p.get("thought")
                    ]
                    thought_parts = [p.get("text", "") for p in parts if p.get("thought")]
                    func_calls = [
                        p.get("functionCall", {}).get("name")
                        for p in parts
                        if "functionCall" in p
                    ]

                    if text_parts:
                        combined = "".join(text_parts)
                        info["response_text"] = combined[:200]
                    if thought_parts:
                        info["thinking_length"] = sum(len(t) for t in thought_parts)
                    if func_calls:
                        info["tool_calls_response"] = func_calls
                    info["finish_reason"] = candidates[0].get("finishReason", "?")

                usage = resp.get("usageMetadata", {})
                if usage:
                    info["input_tokens"] = usage.get("promptTokenCount", 0)
                    info["output_tokens"] = usage.get("candidatesTokenCount", 0)

            if "access_token" in obj:
                info["token_type"] = "access_token_refresh"
                if "expires_in" in obj:
                    info["expires_in"] = obj["expires_in"]

        except (json.JSONDecodeError, TypeError, KeyError):
            pass

        return info

    def _save_dump(self, flow: http.HTTPFlow, req_body: str, resp_body: str):
        self.request_count += 1
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        label = self._get_path_label(flow.request.path)
        filename = f"{ts}_{self.request_count:04d}_{label}.json"
        filepath = os.path.join(JSON_LOG_DIR, filename)

        dump = {
            "timestamp": datetime.now().isoformat(),
            "request": {
                "method": flow.request.method,
                "url": self._sanitize_url(flow.request.pretty_url),
                "headers": self._sanitize_headers(dict(flow.request.headers)),
            },
            "response": {
                "status_code": flow.response.status_code if flow.response else None,
                "headers": self._sanitize_headers(dict(flow.response.headers))
                if flow.response
                else None,
            },
        }

        sanitized_req_body = self._sanitize_body_payload(req_body)
        if isinstance(sanitized_req_body, (dict, list)):
            dump["request"]["body"] = sanitized_req_body
        elif sanitized_req_body:
            dump["request"]["body_raw"] = sanitized_req_body[:2000]

        sanitized_resp_body = self._sanitize_body_payload(resp_body)
        if isinstance(sanitized_resp_body, (dict, list)):
            dump["response"]["body"] = sanitized_resp_body
        elif sanitized_resp_body:
            dump["response"]["body_raw"] = sanitized_resp_body[:2000]

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(dump, f, indent=2, ensure_ascii=False)
        self._secure_path(filepath)

    def _log_to_file(self, text: str):
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(text + "\n")

    def request(self, flow: http.HTTPFlow):
        if not self._is_target(flow):
            return

        path_label = self._get_path_label(flow.request.path)
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        print(
            f"\n{Colors.BOLD}{Colors.YELLOW}REQUEST{Colors.RESET} "
            f"{Colors.CYAN}[{ts}]{Colors.RESET} "
            f"{Colors.BOLD}{flow.request.method}{Colors.RESET} "
            f"{Colors.GREEN}{path_label}{Colors.RESET}"
        )
        print(
            f"  {Colors.DIM}URL: {self._sanitize_url(flow.request.pretty_url)}{Colors.RESET}"
        )

        ua = flow.request.headers.get("User-Agent", "")
        if ua:
            print(f"  {Colors.DIM}User-Agent: {ua}{Colors.RESET}")
        auth = flow.request.headers.get("Authorization", "")
        if auth:
            scheme = auth.split(" ", 1)[0] if auth else "Bearer"
            print(f"  {Colors.DIM}Auth: {scheme} <redacted>{Colors.RESET}")

        req_body = self._decode_body(flow.request.raw_content, dict(flow.request.headers))
        if req_body:
            key_info = self._extract_key_info(req_body)
            if key_info:
                print(f"  {Colors.MAGENTA}Key Info:{Colors.RESET}")
                for k, v in key_info.items():
                    print(f"    {Colors.DIM}{k}: {v}{Colors.RESET}")

        self._log_to_file(f"\n{'=' * 70}")
        self._log_to_file(
            f"[{ts}] REQUEST {flow.request.method} {self._sanitize_url(flow.request.pretty_url)}"
        )
        self._log_to_file(
            f"Headers: {json.dumps(self._sanitize_headers(dict(flow.request.headers)), indent=2)}"
        )
        sanitized_req_body = self._sanitize_body_payload(req_body)
        if sanitized_req_body:
            self._log_to_file(f"Body:\n{self._serialize_for_log(sanitized_req_body)}")

    def response(self, flow: http.HTTPFlow):
        if not self._is_target(flow):
            return

        path_label = self._get_path_label(flow.request.path)
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        status = flow.response.status_code

        if status < 300:
            status_color = Colors.GREEN
        elif status < 400:
            status_color = Colors.YELLOW
        elif status == 429:
            status_color = Colors.BG_RED + Colors.WHITE
        else:
            status_color = Colors.RED

        print(
            f"\n{Colors.BOLD}{Colors.BLUE}RESPONSE{Colors.RESET} "
            f"{Colors.CYAN}[{ts}]{Colors.RESET} "
            f"{status_color}{Colors.BOLD} {status} {Colors.RESET} "
            f"{Colors.GREEN}{path_label}{Colors.RESET}"
        )

        resp_body = self._decode_body(flow.response.raw_content, dict(flow.response.headers))

        if "text/event-stream" in flow.response.headers.get("content-type", ""):
            print(f"  {Colors.CYAN}[SSE Stream]{Colors.RESET}")
            self._parse_sse_stream(resp_body)
        else:
            if resp_body:
                key_info = self._extract_key_info(resp_body)
                if key_info:
                    print(f"  {Colors.MAGENTA}Key Info:{Colors.RESET}")
                    for k, v in key_info.items():
                        print(f"    {Colors.DIM}{k}: {v}{Colors.RESET}")
                elif status >= 400:
                    sanitized_error = self._sanitize_body_payload(resp_body)
                    print(
                        f"  {Colors.RED}Error: {self._truncate(self._serialize_for_log(sanitized_error), 300)}{Colors.RESET}"
                    )

        self._log_to_file(
            f"[{ts}] RESPONSE {status} {self._sanitize_url(flow.request.pretty_url)}"
        )
        self._log_to_file(
            f"Headers: {json.dumps(self._sanitize_headers(dict(flow.response.headers)), indent=2)}"
        )
        sanitized_resp_body = self._sanitize_body_payload(resp_body)
        if sanitized_resp_body:
            self._log_to_file(f"Body:\n{self._serialize_for_log(sanitized_resp_body)}")

        req_body = self._decode_body(flow.request.raw_content, dict(flow.request.headers))
        self._save_dump(flow, req_body, resp_body)

    def _parse_sse_stream(self, body: str):
        if not body:
            return

        events = body.split("\n\n")
        data_events = []
        for event in events:
            for line in event.strip().split("\n"):
                if line.startswith("data: "):
                    data_str = line[6:]
                    try:
                        data_events.append(json.loads(data_str))
                    except json.JSONDecodeError:
                        pass

        if not data_events:
            print(f"    {Colors.DIM}(no parseable SSE events){Colors.RESET}")
            return

        print(f"    {Colors.DIM}SSE events: {len(data_events)}{Colors.RESET}")

        all_text = []
        all_thinking = []
        tool_calls = []
        total_input_tokens = 0
        total_output_tokens = 0
        finish_reason = None

        for evt in data_events:
            candidates = evt.get("candidates", [])
            for candidate in candidates:
                parts = candidate.get("content", {}).get("parts", [])
                for part in parts:
                    if "text" in part:
                        if part.get("thought"):
                            all_thinking.append(part["text"])
                        else:
                            all_text.append(part["text"])
                    if "functionCall" in part:
                        tool_calls.append(part["functionCall"].get("name", "?"))
                if candidate.get("finishReason"):
                    finish_reason = candidate["finishReason"]

            usage = evt.get("usageMetadata", {})
            if usage.get("promptTokenCount"):
                total_input_tokens = usage["promptTokenCount"]
            if usage.get("candidatesTokenCount"):
                total_output_tokens = usage["candidatesTokenCount"]

        combined_text = "".join(all_text)
        combined_thinking = "".join(all_thinking)

        if combined_thinking:
            print(f"    {Colors.YELLOW}Thinking: {len(combined_thinking)} chars{Colors.RESET}")
        if combined_text:
            print(f"    {Colors.GREEN}Response: {self._truncate(combined_text, 200)}{Colors.RESET}")
        if tool_calls:
            print(f"    {Colors.MAGENTA}Tool calls: {', '.join(tool_calls)}{Colors.RESET}")
        if finish_reason:
            print(f"    {Colors.DIM}Finish: {finish_reason}{Colors.RESET}")
        if total_input_tokens or total_output_tokens:
            print(
                f"    {Colors.DIM}Tokens: {total_input_tokens} in / {total_output_tokens} out{Colors.RESET}"
            )


addons = [AntigravityCapture()]
