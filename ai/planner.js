/* ============================================================
 * 天合小队 Sky Team —— AI 决策器
 *
 * 对外接口：
 *   Planner.decide(state, role, opts) -> { name, args } | null
 *   - name/args 与 server.js 的 handleAction 动作协议一致
 *   - 返回 null 表示「此刻没有我要做的事」（等人 / 不是我回合）
 *
 * 设计要点：
 *   1) 逐颗决策 + 本轮前瞻（rollout 到本轮结算），评估函数自带全局日程压力
 *      —— 这是「不做搜索就赢不了」这个游戏的最小可行方案。
 *   2) fair 模式（默认开）：AI 看不到对手「未放置」的骰子，rollout 时随机化，
 *      避免 AI 用上帝视角作弊。
 *   3) 零依赖，Node / 浏览器通用。
 * ============================================================ */
'use strict';

var SkyAIEvaluate;
if (typeof module !== 'undefined' && module.exports) {
  SkyAIEvaluate = require('./evaluate');
} else if (typeof window !== 'undefined') {
  SkyAIEvaluate = window.SkyAIEvaluate;
}

var WIN_SCORE = SkyAIEvaluate ? SkyAIEvaluate.WIN_SCORE : 10000000;
var LOSE_SCORE = SkyAIEvaluate ? SkyAIEvaluate.LOSE_SCORE : -10000000;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function otherRole(role) { return role === 'pilot' ? 'copilot' : 'pilot'; }
function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

function freeDice(s, role) {
  var out = [];
  for (var i = 0; i < s.dice[role].length; i++) {
    var d = s.dice[role][i];
    if (!d.used && d.v > 0) out.push({ i: i, v: d.v });
  }
  return out;
}

function allSlots(role, Logic) {
  return Object.keys(Logic.SLOTS[role]).concat(Object.keys(Logic.SHARED_SLOTS));
}

/* ============================================================
 * 候选动作枚举（含咖啡修正）
 *
 * 注意：逻辑层的 SLOTS 里 axis/engine 标了 mandatory:true，但
 * slotAllowed() 并不读它 —— 不放必填槽不会当场报错，只会在
 * resolveRound 判「强制槽位未填满」直接摔。所以搜索必须自己做
 * 可行性剪枝：当剩余骰子数刚好够填必填槽时，只能放必填槽。
 * ============================================================ */
function missingMandatory(s, role) {
  var me = s.placements[role], need = [];
  if (me.axis === null) need.push('axis');
  if (me.engine === null) need.push('engine');
  return need;
}

function enumerateMoves(s, role, Logic, opts) {
  opts = opts || {};
  var enforce = opts.enforceMandatory !== false;
  var moves = [], free = freeDice(s, role), slots = allSlots(role, Logic);
  var need = enforce ? missingMandatory(s, role) : [];
  var spare = free.length - 1;   // 这一手用掉一颗后还剩几颗

  for (var i = 0; i < free.length; i++) {
    var x = free[i];
    for (var j = 0; j < slots.length; j++) {
      var slot = slots[j];
      // 骰子刚好够填必填槽时，不许再往非必填槽丢
      if (enforce && need.indexOf(slot) === -1 && spare < need.length) continue;
      for (var v = 1; v <= 6; v++) {
        var cost = Math.abs(v - x.v);
        if (cost > s.coffee) continue;
        if (!Logic.slotAllowed(s, role, slot, v).ok) continue;
        moves.push({
          dieIdx: x.i, slot: slot, val: v,
          cp: Math.max(0, v - x.v), cm: Math.max(0, x.v - v)
        });
      }
    }
  }
  // 全被剪掉时退回无约束枚举，避免无路可走
  if (!moves.length && enforce) return enumerateMoves(s, role, Logic, { enforceMandatory: false });
  return moves;
}

/* ============================================================
 * 快速启发式：把「最接近 target 的值」放到 slot 上
 * 会挑一颗尽量省咖啡的骰子；拿不到精确值时退而求其次。
 * 返回 null 表示做不到。
 * ============================================================ */
function pickValue(s, role, Logic, slot, target) {
  var free = freeDice(s, role);
  var best = null, bestScore = Infinity;
  for (var i = 0; i < free.length; i++) {
    for (var v = 1; v <= 6; v++) {
      var cost = Math.abs(v - free[i].v);
      if (cost > s.coffee) continue;
      if (!Logic.slotAllowed(s, role, slot, v).ok) continue;
      var sc = Math.abs(v - target) * 10 + cost;
      if (sc < bestScore) {
        bestScore = sc;
        best = {
          dieIdx: free[i].i, slot: slot, val: v,
          cp: Math.max(0, v - free[i].v), cm: Math.max(0, free[i].v - v)
        };
      }
    }
  }
  return best;
}

function nextRadioSlot(s, role, Logic) {
  var p = s.placements[role];
  if (!p.radio) return 'radio';
  if (role === 'copilot' && p.radio2 === null) return 'radio2';
  return null;
}

function nextCoffeeSlot(s, Logic) {
  for (var i = 1; i <= Logic.CONFIG.COFFEE_SLOT_COUNT; i++) {
    var cs = 'coffee' + i;
    if (s.placements.shared[cs] === null) return cs;
  }
  return null;
}

/** 想清除的前方交通对应的无线电骰点；没有则 null */
function radioNeededValue(s, Logic) {
  for (var v = 1; v <= 6; v++) {
    if (Logic.hasTraffic(s, s.distance - (v - 1))) return v;
  }
  return null;
}

/** 本轮希望的引擎和 */
function engineTargetSum(s, Logic, cfg) {
  // 着陆轮：引擎和必须严格小于刹车值，越小越安全，直接压到最小值
  if (Logic.isLandingRound(s)) return 2;
  if (Logic.isWaitingMode(s)) return Math.max(2, s.blueMark - 1);       // 等待模式必须 < 蓝标记
  if (Logic.hasTraffic(s, s.distance)) return Math.max(2, s.blueMark - 1); // 当前格有飞机，别前进
  var stepsLeft = s.altitude / cfg.ALTITUDE_STEP;
  if (s.distance >= stepsLeft) return Math.min(s.orangeMark + 1, 12);   // 进度吃紧，冲 2 格
  return s.blueMark;                                                    // 稳推进 1 格
}

/** 按顺序激活的设备里，下一个该做且现在做得到的 */
function equipmentMove(s, role, Logic) {
  if (role === 'pilot') {
    // 刹车最稀缺（只接受点数 2/4/6），优先
    if (s.brakesAct < Logic.CONFIG.BRAKE_COUNT) {
      var bs = 'brake' + (s.brakesAct + 1);
      if (s.placements.pilot[bs] === null) {
        var need = [2, 4, 6][s.brakesAct];
        var mb = pickValue(s, role, Logic, bs, need);
        if (mb && mb.val === need) return mb;
      }
    }
    if (s.gearAct < Logic.CONFIG.GEAR_COUNT) {
      for (var g = 1; g <= Logic.CONFIG.GEAR_COUNT; g++) {
        var gs = 'gear' + g;
        if (s.gearOn[gs] || s.placements.pilot[gs] !== null) continue;
        var mg = pickValue(s, role, Logic, gs, 3);
        if (mg) return mg;
      }
    }
  } else {
    if (s.flapsAct < Logic.CONFIG.FLAP_COUNT) {
      var fs = 'flap' + (s.flapsAct + 1);
      if (s.placements.copilot[fs] === null) {
        var mf = pickValue(s, role, Logic, fs, 3);
        if (mf) return mf;
      }
    }
  }
  return null;
}

function anythingOpen(s, role, Logic, v) {
  var slots = allSlots(role, Logic);
  for (var i = 0; i < slots.length; i++) {
    if (Logic.getPlacement(s, role, slots[i]) !== null) continue;
    if (Logic.slotAllowed(s, role, slots[i], v).ok) return slots[i];
  }
  return null;
}

/* ============================================================
 * 快速启发式决策（确定性、零克隆）
 * 用途：① 前瞻 rollout 里的双方模型；② laya 缺席时的兜底
 * ============================================================ */
/** 填必填槽时的目标值 */
function axisWant(s, role, you, axisSign, Logic, o) {
  // 自然焦点：双方在没有沟通时最容易同时落在中值附近
  var own = clamp(3 + axisSign * s.axis, 1, 6);
  if (o && o.asOpponent) {
    // 对手模型：偶尔会配合跟随，多数时候按自己的中值偏好放
    var coop = (o.coop == null) ? 0.5 : o.coop;
    if (you.axis !== null && Math.random() < coop) {
      return clamp(Logic.effVal(you.axis) + axisSign * s.axis, 1, 6);
    }
    return own;
  }
  // 我方策略：能后手就精确跟随，先手则押中值
  if (you.axis !== null) return clamp(Logic.effVal(you.axis) + axisSign * s.axis, 1, 6);
  return own;
}

function fillMandatory(s, role, Logic, slotName, you, axisSign, cfg, o) {
  var want;
  if (slotName === 'axis') {
    want = axisWant(s, role, you, axisSign, Logic, o);
  } else {
    var tgt = engineTargetSum(s, Logic, cfg);
    want = (you.engine !== null) ? tgt - Logic.effVal(you.engine) : Math.round(tgt / 2);
    want = clamp(want, 1, 6);
  }
  return pickValue(s, role, Logic, slotName, want);
}

/* ============================================================
 * 快速启发式决策（确定性、零克隆）
 *
 * asOpponent=false（我方策略）：
 *   对手一旦放好姿态，立刻精确配平；否则先把清障/设备/咖啡做掉，
 *   把姿态拖到最后 —— 姿态是「差值必须精确等于当前 axis」的协作点，
 *   先手方永远被动，能后手就后手。
 *
 * asOpponent=true（对手模型，用于前瞻）：
 *   真人／菜鸟不会「精确跟随」，只按自己的中值偏好放。
 *   前瞻里必须按这个来，否则会高估自己的协作成功率
 *   —— 这正是修复前 AI 先手随便放个 2、结果被对手放 3 打歪的原因。
 * ============================================================ */
function quickMove(s, role, Logic, cfg, o) {
  o = o || {};
  var free = freeDice(s, role);
  if (!free.length) return null;
  var me = s.placements[role];
  var you = s.placements[otherRole(role)];
  // 姿态结算：s.axis += (pa > ca) ? -diff : diff
  // 要归零就必须让 pa - ca = 当前 axis。机长放 pa、副驾放 ca，符号相反。
  var axisSign = (role === 'pilot') ? 1 : -1;

  /* A) 对手已放姿态且我是「我方」→ 立刻精确跟随（全场最值钱的一次协作） */
  if (me.axis === null && you.axis !== null && !o.asOpponent) {
    var mA = pickValue(s, role, Logic, 'axis',
      clamp(Logic.effVal(you.axis) + axisSign * s.axis, 1, 6));
    if (mA) return mA;
  }
  /* A2) 着陆轮：引擎和必须 < 刹车值，是唯一生死线 —— 抢在对手前面放小值 */
  if (Logic.isLandingRound(s) && me.engine === null) {
    var lE = fillMandatory(s, role, Logic, 'engine', you, axisSign, cfg, o);
    if (lE) return lE;
  }
  /* A3) 着陆轮专用优先级：
   *     这一轮只认四件事 —— 引擎和、姿态水平、跑道清空、设备齐活。
   *     往咖啡槽丢骰子在这里毫无价值（咖啡是修正用资源，着陆轮用不上），
   *     已激活的设备也是死槽。修复前 AI 会把骰子浪费在这些槽位上，
   *     导致姿态凑不出协调值 → 姿态未水平直接判负。 */
  if (Logic.isLandingRound(s)) {
    if (me.axis === null) {
      var lA = fillMandatory(s, role, Logic, 'axis', you, axisSign, cfg, o);
      if (lA) return lA;
    }
    var lR = nextRadioSlot(s, role, Logic);
    if (lR) {
      var lNeed = radioNeededValue(s, Logic);
      if (lNeed !== null) {
        var lM = pickValue(s, role, Logic, lR, lNeed);
        if (lM && lM.val === lNeed) return lM;
      }
    }
    var lEq = equipmentMove(s, role, Logic);
    if (lEq) return lEq;
    // 剩下的骰子随便找非咖啡槽塞掉
    for (var li = 0; li < free.length; li++) {
      for (var lv = 1; lv <= 6; lv++) {
        if (Math.abs(lv - free[li].v) > s.coffee) continue;
        var lSlot = anythingOpen(s, role, Logic, lv);
        if (lSlot && lSlot.indexOf('coffee') !== 0) {
          return {
            dieIdx: free[li].i, slot: lSlot, val: lv,
            cp: Math.max(0, lv - free[li].v), cm: Math.max(0, free[li].v - lv)
          };
        }
      }
    }
    return null;
  }
  /* B) 对手已放引擎 → 立刻配平 */
  if (me.engine === null && you.engine !== null) {
    var mE = pickValue(s, role, Logic, 'engine',
      clamp(engineTargetSum(s, Logic, cfg) - Logic.effVal(you.engine), 1, 6));
    if (mE) return mE;
  }
  /* C) 保险：剩余骰子刚好只够填必填槽时，必须填必填槽 */
  var needLeft = missingMandatory(s, role);
  if (needLeft.length >= free.length) {
    for (var q = 0; q < needLeft.length; q++) {
      var ml = fillMandatory(s, role, Logic, needLeft[q], you, axisSign, cfg, o);
      if (ml) return ml;
    }
    return null;
  }

  /* D) 清障：能清就清，否则不浪费 */
  var rSlot = nextRadioSlot(s, role, Logic);
  if (rSlot) {
    var need = radioNeededValue(s, Logic);
    if (need !== null) {
      var mr = pickValue(s, role, Logic, rSlot, need);
      if (mr && mr.val === need) return mr;
    }
  }
  /* E) 设备 */
  var eq = equipmentMove(s, role, Logic);
  if (eq) return eq;
  /* F) 咖啡 */
  var cs = nextCoffeeSlot(s, Logic);
  if (cs) {
    var mc = pickValue(s, role, Logic, cs, free[0].v);
    if (mc) return mc;
  }
  /* G) 拖到没别的可做了才填必填槽：引擎先放，姿态再等一手 */
  if (me.engine === null) {
    var gE = fillMandatory(s, role, Logic, 'engine', you, axisSign, cfg, o);
    if (gE) return gE;
  }
  if (me.axis === null) {
    var gA = fillMandatory(s, role, Logic, 'axis', you, axisSign, cfg, o);
    if (gA) return gA;
  }
  /* H) 兜底 */
  for (var i = 0; i < free.length; i++) {
    for (var v = 1; v <= 6; v++) {
      var cost = Math.abs(v - free[i].v);
      if (cost > s.coffee) continue;
      var slot = anythingOpen(s, role, Logic, v);
      if (slot) {
        return {
          dieIdx: free[i].i, slot: slot, val: v,
          cp: Math.max(0, v - free[i].v), cm: Math.max(0, free[i].v - v)
        };
      }
    }
  }
  return null;
}

/* ============================================================
 * 前瞻
 *   默认：只走完本轮（含对手），停在 roundEnd / win / lose
 *   opts.toGameEnd：一路模拟到落地或坠毁（更准，也更慢）
 * ============================================================ */
function rollout(s, Logic, cfg, opts) {
  opts = opts || {};
  var toGameEnd = !!opts.toGameEnd;
  var guard = 0;

  /* 第一阶段：把本轮放完 */
  while (s.phase === 'place' && guard++ < 20) {
    var r = s.currentPlayer;
    if (!r) break;
    var mv = quickMove(s, r, Logic, cfg, { asOpponent: r !== opts.aiRole, coop: opts.coop });
    if (!mv) break;
    var res = Logic.placeDie(s, r, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    if (!res || !res.ok) break;
  }
  if (s.phase === 'reveal') Logic.resolveRound(s);
  if (!toGameEnd || s.phase === 'win' || s.phase === 'lose') return s;

  /* 第二阶段（可选）：一路模拟到落地 / 坠毁 */
  while (s.phase !== 'win' && s.phase !== 'lose' && guard++ < 260) {
    if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }
    if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
    if (s.phase === 'roll') {
      Logic.rollDice(s, 'pilot');
      Logic.rollDice(s, 'copilot');
      s.phase = 'place';
      s.currentPlayer = s.startPlayer;
      continue;
    }
    if (s.phase === 'place') {
      var r2 = s.currentPlayer;
      if (!r2) break;
      var mv2 = quickMove(s, r2, Logic, cfg, { asOpponent: r2 !== opts.aiRole, coop: opts.coop });
      if (!mv2) break;
      var res2 = Logic.placeDie(s, r2, mv2.dieIdx, mv2.slot, { coffeePlus: mv2.cp, coffeeMinus: mv2.cm });
      if (!res2 || !res2.ok) break;
      continue;
    }
    break;
  }
  return s;
}

/** fair 模式：把对手「未放置」的骰子随机化（AI 不该看见它们） */
function blindOpponent(t, aiRole) {
  var o = otherRole(aiRole);
  var dice = t.dice[o];
  for (var i = 0; i < dice.length; i++) {
    if (!dice[i].used) dice[i].v = 1 + Math.floor(Math.random() * 6);
  }
}

/* ============================================================
 * 完整版：枚举当前所有合法动作 → rollout → 评估 → 选优
 * ============================================================ */
function rankMoves(s, role, Logic, cfg, opts) {
  opts = opts || {};
  var moves = enumerateMoves(s, role, Logic, opts);
  var fair = opts.fair !== false;
  var samples = Math.max(1, opts.samples | 0 || 1);
  var beforeScore = SkyAIEvaluate.evaluate(s, Logic, cfg) * 0.01;
  var out = [];

  for (var i = 0; i < moves.length; i++) {
    var m = moves[i];
    var sum = 0, valid = false;
    for (var k = 0; k < samples; k++) {
      var t = cloneState(s);
      if (fair) blindOpponent(t, role);
      var res = Logic.placeDie(t, role, m.dieIdx, m.slot, { coffeePlus: m.cp, coffeeMinus: m.cm });
      if (!res || !res.ok) break;
      var v;
      if (t.phase === 'lose') {
        // 依然是死，但「死前局面越好」给一点区分度，避免所有候选同分
        v = LOSE_SCORE + beforeScore;
      } else if (t.phase === 'win') {
        v = WIN_SCORE;
      } else {
        rollout(t, Logic, cfg, { toGameEnd: opts.toGameEnd, aiRole: role, coop: opts.coop });
        v = (t.phase === 'lose') ? LOSE_SCORE + beforeScore
          : (t.phase === 'win') ? WIN_SCORE
          : SkyAIEvaluate.evaluate(t, Logic, cfg);
      }
      sum += v; valid = true;
    }
    if (valid) out.push({ move: m, score: sum / samples });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

function searchBestMove(s, role, Logic, cfg, opts) {
  opts = opts || {};
  var ranked = rankMoves(s, role, Logic, cfg, opts);
  if (!ranked.length) return null;
  // 同分随机，避免每局开局一模一样
  var top = ranked[0].score;
  var ties = ranked.filter(function (r) { return Math.abs(r.score - top) <= 1e-6; });
  var idx = (opts.seed != null) ? (opts.seed % ties.length) : Math.floor(Math.random() * ties.length);
  return ties[idx].move;
}

/* ============================================================
 * 对外接口
 * ============================================================ */
function decidePlace(s, role, Logic, opts) {
  if (s.currentPlayer !== role) return null;    // 不是我的回合
  var cfg = Logic.getScenarioConfig(s);
  var mv = searchBestMove(s, role, Logic, cfg, opts);
  if (!mv) return null;
  return { name: 'place', args: [mv.dieIdx, mv.slot, mv.cp, mv.cm] };
}

function decideRoll(s, role) {
  if (!s.rolled[role]) return { name: 'roll', args: [] };
  if (s.rolled[otherRole(role)]) return { name: 'done-roll', args: [] };
  return null;
}

/**
 * 主入口。
 * @param {object} s     权威 state
 * @param {string} role  AI 扮演的角色（'pilot' | 'copilot'）
 * @param {object} opts  { fair?: boolean, laya?: {decide(s,role,Logic,opts)->move|null} }
 */
function decide(s, role, Logic, opts) {
  opts = opts || {};
  if (!s || !role) return null;

  switch (s.phase) {
    case 'discuss':
      return { name: 'begin-roll', args: [] };
    case 'roll':
      return decideRoll(s, role);
    case 'place':
      if (s.currentPlayer !== role) return null;
      if (opts.laya && typeof opts.laya.decide === 'function') {
        var lm = opts.laya.decide(s, role, Logic, opts);
        if (lm) return { name: 'place', args: [lm.dieIdx, lm.slot, lm.cp || 0, lm.cm || 0] };
      }
      return decidePlace(s, role, Logic, opts);
    case 'reveal':
      return { name: 'settle', args: [] };
    case 'roundEnd':
      return { name: 'next-round', args: [] };
    default:
      return null;
  }
}

var Planner = {
  decide: decide,
  decidePlace: decidePlace,
  rankMoves: rankMoves,
  quickMove: quickMove,
  enumerateMoves: enumerateMoves,
  searchBestMove: searchBestMove,
  rollout: rollout,
  engineTargetSum: engineTargetSum,
  radioNeededValue: radioNeededValue
};
if (typeof module !== 'undefined' && module.exports) module.exports = Planner;
if (typeof window !== 'undefined') window.SkyAIPlanner = Planner;
