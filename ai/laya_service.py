#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
天合小队 Sky Team —— laya 决策服务（常驻进程，模型只加载一次）

为什么要有这一层：
    laya 是 PyTorch 模型，每次决策都冷启一次要 7~10 秒。
    所以做成常驻 HTTP 服务，Node 侧按需 POST 一句话过来问。

依赖：
    pip install laya          # 会自动带上 torch / transformers

国内网络（必须，否则下不动 1.7GB 权重）：
    export HF_HUB_DISABLE_XET=1
    export HF_ENDPOINT=https://hf-mirror.com

启动：
    python3 ai/laya_service.py
    # 首次启动会下载 convaiinnovations/laya，约 1.7GB

环境变量：
    LAYA_PORT         监听端口，默认 7788
    LAYA_MAX_OPTIONS  单次最多给 laya 几个选项，默认 8（laya 在 >20 选项时精度会崩）
    LAYA_PRELOAD      只预载指定 checkpoint，如 multilingual —— 可少下 800MB 英文权重
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 必须在 import laya / huggingface_hub 之前设好
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

LAYA_PORT = int(os.environ.get("LAYA_PORT", "7788"))
MAX_OPTIONS = int(os.environ.get("LAYA_MAX_OPTIONS", "8"))
# 默认 preload=True 会把所有 checkpoint 都拉下来（多语 322M + 英文 421M + typed）。
# 这个游戏全程中文，只留多语版就够，能少下 800MB 左右。
LAYA_PRELOAD = os.environ.get("LAYA_PRELOAD", "")

_router = None
_lock = threading.Lock()          # laya 单例不是线程安全的，串行化


def get_router():
    global _router
    if _router is None:
        from laya import Router
        t0 = time.time()
        names = [n.strip() for n in LAYA_PRELOAD.split(",") if n.strip()]
        if names:
            _router = Router(preload=False)
            _router.preload(names)
        else:
            # preload 是必须的：否则每次语种切换都会重建模型（7~10s）
            _router = Router(preload=True)
        print("[laya] 模型就绪（%s），用时 %.1fs" % (",".join(names) or "全部", time.time() - t0), flush=True)
    return _router


def run_decide(payload):
    state = payload.get("state") or ""
    instructions = payload.get("instructions") or "Pick the single best option."
    options = payload.get("options") or []
    if not options:
        return {"error": "no options"}

    criteria = {}
    for opt in options[:MAX_OPTIONS]:
        # 每个选项文本会被 token 预算平分，太长会互相挤压，这里主动截断
        criteria[str(opt.get("key"))] = str(opt.get("text", ""))[:120]

    questions = {
        "move": {
            "type": "choice",
            "instructions": instructions,
            "criteria": criteria,
        }
    }

    with _lock:
        res = get_router().predict(state, questions)

    ans = (res.get("answers") or {}).get("move") or {}
    routing = res.get("routing") or {}
    return {
        "choice": ans.get("choice"),
        "confidence": ans.get("confidence"),
        "probs": ans.get("probs") or ans.get("probabilities") or {},
        "model": routing.get("model") or routing.get("lang"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": _router is not None, "port": LAYA_PORT,
                             "maxOptions": MAX_OPTIONS})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/decide"):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as e:                              # noqa: BLE001
            self._json(400, {"error": "bad request: %s" % e})
            return

        t0 = time.time()
        try:
            out = run_decide(payload)
        except Exception as e:                              # noqa: BLE001
            self._json(500, {"error": "%s: %s" % (type(e).__name__, e)})
            return
        out["ms"] = round((time.time() - t0) * 1000, 1)
        self._json(200, out)

    def log_message(self, *args):
        pass                                                # 静音默认访问日志


def main():
    print("[laya] 启动中… 端口 %d（首次运行需下载约 1.7GB 权重）" % LAYA_PORT, flush=True)
    try:
        get_router()
    except Exception as e:                                  # noqa: BLE001
        print("[laya] 模型加载失败：%s" % e, flush=True)
        print("[laya] 请确认已 pip install laya，且 HF_HUB_DISABLE_XET=1 / HF_ENDPOINT=https://hf-mirror.com", flush=True)
        raise SystemExit(1)

    srv = ThreadingHTTPServer(("127.0.0.1", LAYA_PORT), Handler)
    print("[laya] 监听 http://127.0.0.1:%d   （POST /decide, GET /health）" % LAYA_PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
