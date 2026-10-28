#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在多语 Laya 上，用胜负标签微调一版天合小队要事选择。

数据由 test/ai/laya-finetune-data.js 生成。16GB 机器上把 micro-batch 收小，
并打开 gradient checkpointing。损失用 soft-ce：标签是硬的「哪条路赢得多」。
"""
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("USE_TF", "0")

from laya.train import TrainConfig, finetune


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    data = os.environ.get("LAYA_TRAIN", os.path.join(root, "data/laya-finetune/train.jsonl"))
    ev = os.environ.get("LAYA_EVAL", os.path.join(root, "data/laya-finetune/eval.jsonl"))
    out = os.environ.get("LAYA_OUT", os.path.join(root, "models/sky-laya"))
    if not os.path.isfile(data):
        print("找不到训练集: %s" % data, file=sys.stderr)
        return 1
    n = sum(1 for line in open(data, encoding="utf-8") if line.strip())
    # 两百来条硬标签，按官方大语料的学习率训，损失会停在「随便猜」。
    # 编码器先冻住，只把决策头的学习率提高，多训一些轮。
    micro = int(os.environ.get("LAYA_MICRO", "8"))
    accum = int(os.environ.get("LAYA_ACCUM", "2"))
    epochs = int(os.environ.get("LAYA_EPOCHS", "30"))
    freeze = os.environ.get("LAYA_FREEZE", "1") == "1"
    has_eval = os.path.isfile(ev) and os.path.getsize(ev) > 0
    config = TrainConfig(
        epochs=epochs,
        micro_batch=micro,
        grad_accum=accum,
        loss="soft-ce",
        shuffle_options=() if os.environ.get("LAYA_SHUFFLE", "1") == "0" else ("choice",),
        freeze_encoder=freeze,
        gradient_checkpointing=not freeze,
        weight_decay=float(os.environ.get("LAYA_WD", "0.01")),
        encoder_lr=float(os.environ.get("LAYA_ENC_LR", "2.5e-5")),
        head_lr=float(os.environ.get("LAYA_HEAD_LR", "5e-4")),
        min_lr=float(os.environ.get("LAYA_MIN_LR", "5e-5")),
        seed=0,
        log_every=40,
        eval_data=ev if has_eval else None,
    )
    print("train rows %d, epochs %d, out %s" % (n, epochs, out), flush=True)
    summary = finetune(data, "multilingual", out, config, device="mps")
    print("saved", summary.get("output_dir"), flush=True)
    comp = summary.get("comparison") or {}
    before = (summary.get("before") or summary.get("before_eval") or {})
    after = (summary.get("after") or summary.get("after_eval") or {})
    if comp:
        print("delta_accuracy", comp.get("delta_accuracy"), flush=True)
    if before or after:
        print("before", before.get("accuracy"), "after", after.get("accuracy"), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
