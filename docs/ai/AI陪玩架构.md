# AI 陪玩架构设计

> 目标：单人打开网页，对面坐着一个「会说话、会示弱、会教人」的队友，而不是一个算得比你快的求解器。
>
> 本文解决三件事：现在的架构哪里撑不住、应该分几层、本地模型接在哪一层。

---

## 0. 结论先行

1. **手和嘴必须分成两个进程、两套预算。** 落子内核实测中位 **1ms**（macro 分叉 p90 414ms），本地 7B 模型一次生成 **1.2–2.3s**。差三个数量级，任何把 LLM 放进落子路径的设计都会把一局 15 分钟的游戏变成 15 分钟等进度条。
2. **本地模型能接，而且只该接「嘴」和「耳朵」。** 实测：台词渲染 1.2–2.3s 可用且规则合规；意图解析中位 780ms、JSON 16/16 合法。落子不让它碰。
3. **陪玩的瓶颈不是棋力，是「AI 不说人话」。** 现在 AI 先手姿态放 3、搭档放 3 之外的值，轴就偏，几轮下来尾旋——而玩家全程只看到一句「🤖 副驾落子」。它有一个隐含假设（`AI_COOP=1`：你会跟着我放），但从不告诉你。

---

## 1. 现状体检：撑不住的四处

| 位置                           | 问题                                                   | 实测/代码依据                                                    |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `server.js:354 runAIStep`    | AI 决策**同步跑在主线程**，macro 触发时阻塞 400–700ms，联机时对面跟着卡      | `ai-player.decide` 是同步函数，包在 `Promise.resolve` 里并不改变它是同步执行的 |
| `ai-player.js:73`            | laya 旁路时先算一遍 `rankMoves`，再 `decideSync` 又算一遍；旁路本身零收益 | `choosePriority` 内部已 `rankMoves`，返回值被丢弃                    |
| `planner.js:815 macroChoose` | 8 组配对种子 × ≤3 臂 × 走到终局，成本 4.7s/局；触发率 37%，改棋率仅 9.5%    | 823 个决策点里分叉 305 次、改棋 29 次                                  |
| `planner.js:816`             | `macroGap/macroSamples` 是环境变量常量，**不能按难度/剩余轮数收放**     | 没有 deadline 概念，AI 不会「想不完就先走」                               |
| `laya-client.js`             | 全部是「旁路 + 置信度门」，微调后平均置信度 0.512 够不到 0.6 的门             | 结果：从未改过一步棋                                                 |
| 全局                           | `macroStats` 是模块级单例，多房间共享                            | 只影响统计，但会污染 trace                                           |

---

## 2. 设计原则

1. **LLM 永不落子。** 它只做两件事：把结构化意图写成话、把玩家的话解析成意图。任何模型输出都经过 schema 校验 + 模板兜底。
2. **一切可降级。** 模型不在、超时、胡说，游戏照常进行——这条沿用 `laya-client` 的熔断模式，成本极低。
3. **提议是协议对象，不是字符串。** `Proposal` 由 planner 生成，UI 直接渲染；LLM 版本只是同一对象的「说法」。
4. **提议里没有点数。** Sky Team 规则禁止在讨论阶段报点数。这条限制看起来是障碍，其实是设计红利：它强迫提议停留在「意图层」，正好保住桌游的乐趣，也天然合规（实测模型输出也没有吐数字）。
5. **手要快，嘴可以慢。** 嘴的延迟藏在「掷骰后→放置前」这个本来就有几秒的窗口里，玩家感知不到。

---

## 3. 五层架构

```
┌───────────────────────────────────────────────────────────┐
│ 5. 表达层 voice/                                          │
│    render(Proposal) → 一句人话      parse(人话) → Intent    │
│    本地 LLM（llama.cpp / mlx / ollama）｜模板兜底           │
│    预算 2500ms，超时用模板                                  │
├───────────────────────────────────────────────────────────┤
│ 4. 协作层 council/                                        │
│    Proposal 交换 · 玩家回应 · partnerModel 维护             │
│    产出：{ promised, trust, coop } → 喂给策略层             │
├───────────────────────────────────────────────────────────┤
│ 3. 策略层 brain/  （可插拔，都在 worker 里）                │
│    macro 搜索 ｜ 蒸馏模型 ｜ laya 候选排序 ｜ 浅层评分       │
│    输入 ranked + partnerModel + deadline，输出 move        │
├───────────────────────────────────────────────────────────┤
│ 2. 内核层 engine/ （零依赖、纯净、可测）                    │
│    prob.js 精确概率 · evaluate.js 局面分 · 规则枚举          │
│    中位 1ms，无 IO，无随机（可播种）                        │
├───────────────────────────────────────────────────────────┤
│ 1. 落地层 hands/ （服务端权威，玩家看不到）                 │
│    Logic.placeDie · 状态机 · sanitize · 广播                │
└───────────────────────────────────────────────────────────┘
```

数据流：

```
roll 完成
  │
  ├─(1ms) 内核层 rankMoves + tagMove
  │        │
  │        └─→ 策略层决定「我吃哪个槽」 → 生成 Proposal（结构化，无点数）
  │
  ├─(0ms) 广播 Proposal → UI 立刻显示图标/短标签「我吃姿态」「帮我看刹车」
  │
  ├─(1.2~2.3s) 表达层把 Proposal 渲染成一句人话 → 追加到同一气泡
  │
  ├─(玩家) 一键回应（0ms，规则匹配）或自由输入（780ms，LLM 解析）
  │        └─→ council 更新 partnerModel：{ promised.axis, coop, trust }
  │
  └─(1~600ms) 放置阶段：策略层用 partnerModel 重算 → 落子
```

**为什么提议要「先结构化、后自然语言」两步发？**  
先发的结构化标签是确定性的、5ms 内到位，玩家不会等；自然语言版本到了就替换/补一句。这样即使模型挂了，玩家看到的仍然是一条有用的队友信息，只是话糙一点。**永远不要让玩家盯着一句「正在输入…」。**

---

## 4. 关键接口

### 4.1 Proposal（由 planner 生成，不由 LLM 生成）

```js
/**
 * @typedef {Object} Proposal
 * @property {number} round
 * @property {'axis'|'engine'|'radio'|'equip'|'coffee'|'warn'} kind
 * @property {string|null} slot        'gear2' | 'brake1' | null
 * @property {'low'|'mid'|'high'} urgency
 * @property {string} reasonCode       闭集，给渲染器选模板/提示
 * @property {Object} reasonArgs       渲染素材，**不含任何骰子点数**
 * @property {string[]} askSlots       希望对方避让或承担的槽位
 */
```

`reasonCode` 闭集（足够覆盖 90% 场景）：

| code             | 什么时候发        | 渲染示例（模板兜底）      |
| ---------------- | ------------ | --------------- |
| `AXIS_TAKE`      | 我打算这轮吃姿态     | 这轮姿态我来，你别碰      |
| `AXIS_NEED_MATE` | 我配不平，需要你先放   | 你先把姿态放了吧，我跟着配   |
| `LANDING_SUM`    | 着陆轮且我是先手     | 着陆轮，引擎得压住，两边都放小 |
| `GEAR_DEADLINE`  | 起落架按剩余轮数已经不够 | 起落架还差一个，再拖就来不及  |
| `RADIO_URGENT`   | 飞机快进机场       | 前面那架得清掉，我打无线电   |
| `BRAKE_SHARE`    | 刹车没人管        | 刹车我一个都没动，你分一个   |
| `CANT_MATCH`     | 读牌后发现配不上     | 你刚放的这个我配不平      |

### 4.2 策略层注入的 partnerModel

现在的 `opts.coop` 是一个标量，表达不了「他刚答应过我」。改成：

```js
opts.partner = {
  coop: 1.0,              // 泛化信任，等价于今天的 AI_COOP
  promised: { axis: 3 },  // 玩家通过提议通道确认过的槽位/意图
  trust: 0.9,             // 承诺兑现率（按房间历史滚动）
  visible: true           // 是否看得到对方未放骰子（公平档开关）
};
```

`planner.axisWant()` 里那句「对手会跟着我放同一个值」的假设，改为优先读 `promised.axis`：有承诺用确定值，没承诺才走 `coop` 抽样。**这一处改动同时修掉公平档崩塌和「AI 带不动新手」。**

### 4.3 表达层

```js
// ai/voice/index.js
module.exports = {
  render(proposal, state) -> Promise<string>,   // 模板 / LLM
  parse(text) -> Promise<Intent>,               // 闭集分类
  health() -> Promise<{ok, model, ms}>
};
```

- `VOICE=template`（默认）：纯字符串模板，零依赖零延迟。
- `VOICE=llm`：走 `ai/voice/llm-client.js`，OpenAI 兼容 `/v1/chat/completions`。
- 预算：`render` 2500ms、`parse` 1500ms，超时即降级。连续失败 30s 熔断（复用 laya-client 的 `trip()` 模式）。

### 4.4 服务端新增动作

```js
{ name: 'propose', args: [proposal] }   // AI 发出
{ name: 'reply',   args: [intent] }     // 玩家回应，intent 来自按钮或 parse()
```

房间态新增：

```js
room.council = {
  proposal: Proposal | null,
  reply: { pilot: Intent | null, copilot: Intent | null },
  history: []   // 每轮一条，进复盘
};
```

`sanitize()` 不用改：Proposal 本来就不含点数，广播给双方是安全的。

---

## 5. 本地模型接入

### 5.1 实测（本机 M4 / 16GB / qwen2.5-7b-q4_k_m / llama.cpp 9209）

| 任务   | 输入          | 输出       | 延迟                   | 质量                                        |
| ---- | ----------- | -------- | -------------------- | ----------------------------------------- |
| 台词渲染 | 229–244 tok | 9–16 tok | 1.2–2.3s（4–10 tok/s） | 3/4 直接可用，1 次把意图解释出来了；**0 次吐点数**           |
| 意图解析 | ~250 tok    | ~10 tok  | 中位 780ms（593–1870）   | JSON 16/16 合法，意图 16/16 正确（8 例 × 2 温度，小样本） |

结论：**7B Q4 在这两个任务上够用，但只够「嘴」。**

### 5.2 三条红线

1. **不进落子路径。** 内核 1ms vs 模型 780ms，没有任何理由。
2. **不做自由生成式决策。** 让模型直接输出 `{dieIdx, slot}` 需要 constrained decoding，且这个游戏是精确计数博弈，4B 以下必错。
3. **不替代 laya 的微调路线。** 那条路的问题是信息集不一致 + 没有 ground truth，换个模型不解决。

### 5.3 接入方式（一个环境变量切换，全部 OpenAI 兼容）

```bash
# llama.cpp（本机已在用）
llama-server -m ~/models/qwen2.5-7b.q4_k_m.gguf --port 8090 -c 4096 -t 6

# 或 mlx（Apple 芯片上更快，需先下载权重；现在缓存里那几个是空壳）
~/.pyenv/versions/3.12.4/bin/python -m mlx_lm.server --model mlx-community/gemma-4-e2b-it-4bit --port 8090

# 或 ollama
ollama serve   # 11434

VOICE=llm LLM_BASE=http://127.0.0.1:8090/v1 LLM_MODEL=qwen2.5-7b node server.js
```

### 5.4 模型选型

| 用途       | 建议                                          | 理由                                |
| -------- | ------------------------------------------- | --------------------------------- |
| 台词渲染（主）  | 7B Q4 够；想更快用 1–2B（gemma-4-e2b / Qwen3-0.6B） | 任务被压成「改写」，1–2B 就够，300–600ms       |
| 意图解析     | **laya（322M，50ms）优先试**，7B 做兜底               | 闭集分类是 laya 的原生能力，且权重已在本机。省 15 倍延迟 |
| 复盘点评（P1） | 7B，离线批量                                     | 没有延迟压力，可以慢慢写                      |



> 顺带：这是 laya 在这个项目里**唯一**有 ground truth 的位置——固定意图集合 = 天然标签，准确率可直接测。比让它挑要事靠谱得多。

### 5.5 内存预算

7B Q4 = 4.3GB 常驻。16GB 上：Node + 浏览器 + 模型 ≈ 7–8GB，安全。**但同时开 ComfyUI 就会紧张**——所以 voice 服务要支持「用时加载、闲置 10 分钟卸载」（llama-server 的 `--no-warmup` + 外部启停脚本即可）。

---

## 6. 难度不是开关，是四个旋钮

`AI_FAIR` 那种「一个开关摆动 74 个百分点」（97.5% → 23.3%）不能当难度用——那是**崩塌**，不是变弱。

```js
AI_PROFILE = {
  knowledge: 'full' | 'blind',   // 是否使用对方未放骰子
  lookahead: 0 | 'last2' | 'all',// macro 何时开、M 取几
  noise: 0.0 ~ 0.2,              // 按分差 softmax 采样，制造「人类手滑」
  talk: 'off' | 'hint' | 'full' | 'coach'  // 提议频率与详细度
}
```

预设与验收：

| 档        | knowledge | lookahead | noise | talk  | 目标胜率（新手） | 目标（熟手） |
| -------- | --------- | --------- | ----- | ----- | -------- | ------ |
| `easy`   | full      | 0         | 0.2   | full  | 70–80%   | 85%+   |
| `normal` | full      | last2     | 0.1   | full  | 55–65%   | 70–85% |
| `hard`   | full      | all       | 0     | hint  | 35–45%   | 55–65% |
| `coach`  | full      | all       | 0     | coach | 只提示不落子   | 同左     |

**关键：`talk` 是难度的一部分。** 一个会说明天要下雨的队友比一个 97.5% 胜率的黑箱更像人。`coach` 档（只提示不落子）可能是这个项目最有价值的产品形态——它把「陪玩」变成「带教」。

---

## 7. 可观测性

每一步落子留一条 trace，落 `data/ai-trace/<room>-<round>.json`：

```json
{
  "round": 3, "role": "copilot", "ms": 412,
  "ranked": [{ "move": "2/axis/3", "score": 103423, "priorities": ["match_axis"] }],
  "macro": { "fired": true, "arms": 2, "wins": [5, 3], "switch": false },
  "proposal": { "kind": "axis", "reasonCode": "AXIS_TAKE", "urgency": "mid" },
  "voice": { "engine": "llm", "ms": 1412, "fallback": false },
  "partner": { "coop": 1, "promised": null, "visible": true }
}
```

用途：调参、复盘、以后要做蒸馏时直接是训练数据。`macroStats` 那个模块级单例要改成按房间实例。

---

## 8. 分阶段落地

### P0（先让它能开口，其余不动）

1. `ai/council.js`：Proposal 生成 + `reasonCode` 闭集 + partnerModel 维护。
2. `planner` 接受 `opts.partner`，`axisWant` 优先读 `promised`。
3. `ai/voice/`：模板实现 + `VOICE=llm` 走 OpenAI 兼容；超时/熔断/兜底。
4. 服务端 `propose` / `reply` 动作 + UI 一行气泡 + 两个按钮（我跟 / 我跟不了）。
5. 修 `ai-player.js:73` 的重复 `rankMoves`。

验收：中级搭档胜率 30% → 60%+（用 `test-ai.js` 加一档 `ai-duo` 回归，≥100 局）。

### P1（让它跑得动、教得会）

1. brain 搬进 `worker_threads`，传 deadline；macro 超预算自动降 M。
2. `AI_PROFILE` 四档 + 每档 100 局回归矩阵（三关 × 四档）。
3. 复盘：局末读 trace，生成 3 条点评（LLM 离线，`train-record.js` 的格式可直接复用）。

### P2（探索）

1. laya 转「耳朵」：闭集意图 + 少样本校准，量准确率与 780ms 的 LLM 对比。
2. 公平档（屏风规则）：`knowledge: 'blind'` + 承诺机制，看能不能把 23.3% 拉回 55%。这是原版桌游的形态，也是这个项目唯一还没实现的「真规则」。

---

## 9. 明确不做

- ❌ **不用 LLM 直接选落子。** 精确计数博弈 + 15 分钟一局，延迟和错误率都不可接受。
- ❌ **不追 Laya 的胜率。** 老师已经 97.5%，学生上限就是老师；而 19/23 的分歧点结果等价，选准也换不来胜率。
- ❌ **不加新的中间表示层。** 现在的 `ranked + priorities` 已经够了，问题在「没往外说」，不在「算得不够细」。

---

## 10. 一句话

**这个 AI 现在缺的不是脑子，是嘴。** 把嘴接上，本地 7B 就够用，代码量比 `planner.js` 那 481 行改动小得多，而玩家感受到的差别比胜率从 45% 涨到 97.5% 更大。
