#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
提示词真实样本的 token 账本。

拿 test/ai/laya-samples.js 落盘的真实 payload，用 laya 自己的 tokenizer 和
build_sequence() 逐条过一遍，看它到底被切成什么样、有没有被截断。

前置：
    node test/ai/laya-samples.js 300        # 生成 test/ai/.samples-payload.json
    python3 test/ai/laya-samples.py

依赖：跑在装了 laya 的 venv 里（/tmp/laya_run_venv）。
"""
import json
import os
import sys

SNAP = os.path.expanduser(
    "~/.cache/huggingface/hub/models--convaiinnovations--laya/snapshots/"
    "7b928d828b7b0e022f929d9bd2e44165aa270148")

HERE = os.path.dirname(os.path.abspath(__file__))
PAYLOAD = os.environ.get("SAMPLES_PAYLOAD", os.path.join(HERE, ".samples-payload.json"))

# 多语 checkpoint 的配置（中文游戏走这个）
MAX_LEN = 1024
HEAD_MAX_LEN = 256


def main():
    if not os.path.exists(PAYLOAD):
        print("找不到 %s —— 先跑 node test/ai/laya-samples.js 300" % PAYLOAD)
        return 1

    from transformers import AutoTokenizer
    from laya.common import build_sequence, render_options

    tok = AutoTokenizer.from_pretrained(os.path.join(SNAP, "multilingual", "tokenizer"))
    samples = json.load(open(PAYLOAD, encoding="utf-8"))

    def ledger(state, instructions, options, label):
        crit = {}
        for o in options:
            crit[str(o["key"])] = str(o["text"])

        q = {"t": "choice", "ins": instructions, "crit": crit}
        ids, markers, stats, trunc = build_sequence(
            tok, state, q, max_len=MAX_LEN, head_max_len=HEAD_MAX_LEN,
            return_stats=True, return_truncation_stats=True)

        ins_tok = len(tok("choice question: " + instructions, add_special_tokens=False)["input_ids"])
        opt_tok = sum(len(tok(" " + o["text"], add_special_tokens=False,
                              truncation=True, max_length=48)["input_ids"]) for o in options)
        # 每个选项被真实切了多少 token（含前置 [MASK]）
        per_opt = [len(tok(" " + o["text"], add_special_tokens=False,
                           truncation=True, max_length=48)["input_ids"]) + 1 for o in options]

        print("  【%s】%d 个选项" % (label, len(options)))
        print("     指令           %4d tok   （占 head 的 %.0f%%）"
              % (ins_tok, ins_tok / float(HEAD_MAX_LEN) * 100))
        print("     选项合计       %4d tok   逐个 " % opt_tok + str(per_opt))
        print("     head 实际      %4d tok   （上限 %d）" % (len(ids) - trunc["state_tokens_used"] - 1,
                                                             HEAD_MAX_LEN))
        print("     状态需要       %4d tok" % trunc["state_tokens"])
        print("     状态实际用     %4d tok" % trunc["state_tokens_used"])
        dropped = trunc["state_tokens_dropped"]
        print("     状态被丢弃     %4d tok   %s" % (
            dropped, "⚠ 有截断" if trunc["truncated"] else "✓ 无截断"))
        if stats.get("tokens_per_option") is not None:
            print("     ⚠ 触发了选项压缩：每个选项被砍到 %d tok" % stats["tokens_per_option"])
        print("     整条序列       %4d tok   （上限 %d，余量 %.0f%%）"
              % (len(ids), MAX_LEN, (1 - len(ids) / float(MAX_LEN)) * 100))
        return len(ids), trunc

    print("=" * 74)
    print("提示词 token 账本（多语 checkpoint：max_len=%d / head_max_len=%d）"
          % (MAX_LEN, HEAD_MAX_LEN))
    print("=" * 74)

    for i, sm in enumerate(samples):
        if sm["activeCount"] < 2:
            continue
        print("\n【样本 %d】%s  第%d轮%s  合法落子 %d 个"
              % (i + 1, sm["tag"], sm["round"], "（着陆轮）" if sm["landing"] else "",
                 sm["legality"]))
        ledger(sm["payload"]["state"], sm["payload"]["instructions"],
               sm["payload"]["options"], "现行：选项 = 要事")
        if sm.get("moveLevel"):
            print()
            ledger(sm["moveLevel"]["state"], sm["moveLevel"]["instructions"],
                   sm["moveLevel"]["options"], "对照：选项 = 落子")

    # 极限推演：把某局的全部合法落子当选项会怎样
    rich = [s for s in samples if s.get("allMoves")]
    run = 0
    for sm in rich:
        state = sm["payload"]["state"]
        ins = sm["payload"]["instructions"]
        texts = sm["allMoves"]
        if len(texts) < 10:
            continue
        fake = [{"key": ("abcdefghijklmnopqrstuvwxyz"[k % 26]) + str(k), "text": t}
                for k, t in enumerate(texts)]
        print("\n" + "-" * 74)
        print("极限推演：把这一局的全部合法落子直接当选项")
        print("  局面：%s 第%d轮  合法落子 %d 个，去重后 %d 条文本"
              % (sm["tag"], sm["round"], sm["legality"], len(texts)))
        print("-" * 74)
        ledger(state, ins, fake, "落子全集")
        run += 1
        if run >= 2:
            break

    return 0


if __name__ == "__main__":
    sys.exit(main())
