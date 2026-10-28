#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
指令到底有没有用？—— 消融实验

前置：
  1) 起 laya 服务：python3 ai/laya_service.py
  2) 生成决策点：node test/ai/laya-ablation-dump.js 400
  3) 跑实验：    python3 test/ai/laya-ablation.py

环境变量：LAYA_SVC（默认 http://127.0.0.1:7788/decide）、ABLATION_PAYLOAD
A) 预算账本：指令花的到底是谁的 token
B) 指令消融：换掉指令，看选项概率分布怎么变（中局 + 着陆轮两个决策点）
C) 位置敏感：同一组选项，只做排列，看选中的是「语义」还是「位置」
D) 确定性：同输入重复，确认差异不是随机性
"""
import json, os, urllib.request, itertools

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

SVC = os.environ.get("LAYA_SVC", "http://127.0.0.1:7788/decide")
SNAP = os.path.expanduser("~/.cache/huggingface/hub/models--convaiinnovations--laya/snapshots")
SNAP = os.path.join(SNAP, os.listdir(SNAP)[0])

PAYLOAD = os.environ.get("ABLATION_PAYLOAD",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ablation-payload.json"))
payloads = json.load(open(PAYLOAD, encoding="utf-8"))
CASES = {p["tag"]: p for p in payloads}

CUR = "你是{role}。机长和副驾合作，要在 {rounds} 轮内把客机安全降落。下面几件事现在都做得成。请只选一件最该先做的。"

VARIANTS = [
    ("full",      None),                      # 现行完整版，按角色填
    ("role_only", "你是{role}。"),
    ("goal_only", "要在 {rounds} 轮内把客机安全降落。请只选一件最该先做的。"),
    ("minimal",   "请只选一件最该先做的。"),
    ("empty",     ""),
    ("swap_role", "你是{swapped}。机长和副驾合作，要在 {rounds} 轮内把客机安全降落。下面几件事现在都做得成。请只选一件最该先做的。"),
    ("noise",     "你是{role}。紫色香蕉在周三跳舞。下面几件事现在都做得成。请只选一件最该先做的。"),
    ("policy",    "你是{role}。{rounds} 轮内必须降落。引擎是生死线，必须先放；姿态可以等对手放了再跟随。请只选一件最该先做的。"),
]


def fill(tpl, case):
    role = "机长" if case["role"] == "pilot" else "副驾"
    swapped = "副驾" if case["role"] == "pilot" else "机长"
    return (tpl if tpl is not None else CUR).format(role=role, swapped=swapped, rounds=case["rounds"])


def call(state, instructions, options):
    body = json.dumps({"state": state, "instructions": instructions,
                       "options": options}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SVC, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def lab(case, key):
    for o in case["options"]:
        if o["key"] == key:
            return o["id"]
    return key


# ---------------------------------------------------------------- A 预算账本
def part_a():
    print("=" * 80)
    print("A) 预算账本：指令的 token 从谁身上扣")
    print("=" * 80)
    try:
        from transformers import AutoTokenizer
        from laya.common import build_sequence, build_head
    except Exception as e:
        print("  跳过（依赖不可用：%s）" % e)
        return
    tok = AutoTokenizer.from_pretrained(os.path.join(SNAP, "multilingual", "tokenizer"))
    case = CASES["landing"]
    OPTS = case["options"]
    q = {"t": "choice", "ins": "", "crit": {o["key"]: o["text"] for o in OPTS}}

    print("  决策点：%s（%d 个选项）\n" % (case["tag"], len(OPTS)))
    print("  %-10s %8s %8s %8s %10s %10s %8s %6s" %
          ("变体", "指令tok", "选项tok", "头部长", "可用room", "状态tok", "丢弃", "截断"))
    rows = []
    for name, tpl in VARIANTS:
        ins = fill(tpl, case)
        q["ins"] = ins
        head_ids, _, stats = build_head(tok, q, 256)
        _, _, _, trunc = build_sequence(tok, case["state"], q, max_len=1024,
                                        head_max_len=256, return_stats=True,
                                        return_truncation_stats=True)
        instr_tok = len(tok("choice question: " + ins, add_special_tokens=False)["input_ids"])
        opt_tok = sum(min(48, len(tok(" " + o["text"], add_special_tokens=False)["input_ids"]) + 1)
                      for o in OPTS)
        rows.append((name, instr_tok, opt_tok, len(head_ids), 1024 - len(head_ids) - 1,
                     trunc["state_tokens"], trunc["state_tokens_dropped"], trunc["truncated"],
                     stats.get("tokens_per_option"), stats.get("options_distinct")))
    for r in rows:
        print("  %-10s %8d %8d %8d %10d %10d %8d %6s" % (
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], "是" if r[7] else "否"))
    print("\n  选项是否被压缩：%s   可区分选项数：%s" % (rows[0][8], rows[0][9]))
    print("  状态实际用量 %d / 可用 room 区间 [%d, %d] → 余量 %.0f%%" % (
        rows[0][5], min(r[4] for r in rows), max(r[4] for r in rows),
        100.0 * (1 - rows[0][5] / min(r[4] for r in rows))))


# ------------------------------------------------------------------ B 消融
def part_b(tag):
    case = CASES[tag]
    print()
    print("=" * 80)
    print("B) 指令消融 · 决策点 = %s（规划器自己的首选 = %s）" % (tag, case.get("plannerTop")))
    print("=" * 80)
    print("  选项：" + "   ".join("%s=%s" % (o["key"], o["id"]) for o in case["options"]))
    print("  %-10s %-22s %6s %-13s %s" % ("变体", "选中", "conf", "模型", "概率分布"))
    opts = [{"key": o["key"], "text": o["text"]} for o in case["options"]]
    probs_all = {}
    for name, tpl in VARIANTS:
        ins = fill(tpl, case)
        try:
            res = call(case["state"], ins, opts)
        except Exception as e:
            print("  %-10s 失败: %s" % (name, e))
            continue
        ch = res.get("choice")
        pr = res.get("probs") or {}
        probs_all[name] = pr
        print("  %-10s %-22s %6.3f %-13s %s" % (
            name, "%s(%s)" % (ch, lab(case, ch)), res.get("confidence") or 0,
            res.get("model") or "-",
            "  ".join("%s=%.2f" % (k, pr.get(k, 0)) for k in sorted(pr))))
    # 汇总：argmax 是否一致、概率摆幅
    if probs_all:
        chs = set()
        for name, tpl in VARIANTS:
            if name in probs_all:
                chs.add(max(probs_all[name], key=probs_all[name].get))
        print("\n  不同指令下选中的选项集合：%s  → %s" % (
            sorted(chs), "完全一致，指令不影响排序" if len(chs) == 1 else "发生了翻转"))
        for k in sorted(probs_all["full"]):
            vals = [probs_all[n].get(k, 0) for n in probs_all]
            print("    选项 %s 概率区间 [%.2f, %.2f]  摆幅 %.2f" % (k, min(vals), max(vals), max(vals) - min(vals)))


# ------------------------------------------------------------ C 位置敏感
def part_c(tag):
    case = CASES[tag]
    print()
    print("=" * 80)
    print("C) 位置敏感 · 决策点 = %s（只换选项排列，文本逐字不变）" % tag)
    print("=" * 80)
    ins = fill(None, case)
    keys = [o["key"] for o in case["options"]]
    by_key = {o["key"]: o["text"] for o in case["options"]}
    if len(keys) < 3:
        print("  只有 %d 个选项，排列测试需要 ≥3 个，跳过" % len(keys))
        return
    perc = list(itertools.permutations(keys))
    print("  %-22s %-14s %-22s %s" % ("排列顺序", "选中位置", "选中语义", "概率分布"))
    picks = []
    for perm in perc:
        o = [{"key": k, "text": by_key[k]} for k in perm]
        res = call(case["state"], ins, o)
        ch = res.get("choice")
        pr = res.get("probs") or {}
        pos = [x["key"] for x in o].index(ch) + 1
        picks.append((pos, lab(case, ch)))
        print("  %-22s 第 %d 位        %-22s %s" % (
            "".join(perm), pos, lab(case, ch),
            "  ".join("%s=%.2f" % (k, pr.get(k, 0)) for k in sorted(pr))))
    pos_set = set(p[0] for p in picks)
    sem_set = set(p[1] for p in picks)
    print("\n  选中的位置集合 %s ；选中的语义集合 %s" % (sorted(pos_set), sorted(sem_set)))
    if len(sem_set) == 1:
        print("  → 语义稳定：排列不影响它选哪个选项（无位置偏置）")
    elif len(pos_set) == 1:
        print("  → 位置稳定：它选的是「第 %d 位」而不是某个内容（存在位置偏置）" % list(pos_set)[0])
    else:
        print("  → 两者都在变：对排列敏感")


# ------------------------------------------------------------ D 确定性
def part_d(tag):
    case = CASES[tag]
    print()
    print("=" * 80)
    print("D) 确定性 · 决策点 = %s" % tag)
    print("=" * 80)
    opts = [{"key": o["key"], "text": o["text"]} for o in case["options"]]
    seen = []
    for _ in range(3):
        res = call(case["state"], fill(None, case), opts)
        pr = res.get("probs") or {}
        seen.append((res.get("choice"), tuple(sorted((k, round(v, 4)) for k, v in pr.items()))))
    print("  三次结果完全一致：%s" % ("是" if len(set(seen)) == 1 else "否"))


if __name__ == "__main__":
    part_a()
    for t in ("midgame", "landing"):
        part_b(t)
    part_c("landing")
    part_d("landing")
