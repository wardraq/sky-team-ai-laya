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
 *   4) opts.macro：要事代表手的分数接近时，用同一批未来骰子打到终局再选。
 *      终局里的后续落子仍用评分，不会再套一次宏观选择。
 *   5) opts.prob：姿态按对方剩余骰子都躲不开才坠毁来选；引擎先按高度和距离
 *      定走几格。本回合做成的襟翼、起落架、刹车和清掉的飞机另加分。
 * ============================================================ */
'use strict';

var SkyAIEvaluate;
var SkyAIProb;
if (typeof module !== 'undefined' && module.exports) {
  SkyAIEvaluate = require('./evaluate');
  SkyAIProb = require('./prob');
} else if (typeof window !== 'undefined') {
  SkyAIEvaluate = window.SkyAIEvaluate;
  SkyAIProb = window.SkyAIProb;
}

var WIN_SCORE = SkyAIEvaluate ? SkyAIEvaluate.WIN_SCORE : 10000000;
var LOSE_SCORE = SkyAIEvaluate ? SkyAIEvaluate.LOSE_SCORE : -10000000;

/* 规划器内部有两种随机性，必须分开对待：
 *   (a) 策略噪声 —— 对手建模的配合抽样、同分兜底。测试里要固定下来，
 *       否则「同一局面 → 同一决策」不可复现，配对实验也会因随机流错位而失真。
 *   (b) 游戏随机 —— rollout 里掷骰子（下面用的仍是全局 Math.random）。
 *       它必须和真实对局共用同一条流，所以**不在这里替换**。
 * 默认 (a) 也是 Math.random，行为与改动前完全一致。 */
var _rng = Math.random;
function setRng(fn) { _rng = (typeof fn === 'function') ? fn : Math.random; }
function rnd() { return _rng(); }

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

function isSpentGear(s, slot) {
  return slot.indexOf('gear') === 0 && s.gearOn && s.gearOn[slot];
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
      if (!opts.allowSpentGear && isSpentGear(s, slot)) continue;
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
  // 全被剪掉时退回无约束枚举，避免无路可走。已激活的起落架只有无其他槽时才允许。
  if (!moves.length && enforce) {
    return enumerateMoves(s, role, Logic, { enforceMandatory: false, allowSpentGear: opts.allowSpentGear });
  }
  if (!moves.length && !opts.allowSpentGear) {
    return enumerateMoves(s, role, Logic, { enforceMandatory: false, allowSpentGear: true });
  }
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
function engineTargetSum(s, Logic, cfg, probMode) {
  // 着陆轮：引擎和必须严格小于刹车值，越小越安全，直接压到最小值
  if (Logic.isLandingRound(s)) return 2;
  if (Logic.isWaitingMode(s)) return Math.max(2, s.blueMark - 1);       // 等待模式必须 < 蓝标记
  if (probMode && SkyAIProb) {
    var k = SkyAIProb.bestStep(s, cfg);
    if (k === 0) return Math.max(2, s.blueMark - 1);
    if (k === 2) return Math.min((s.orangeMark || 8) + 1, 12);
    return s.blueMark;
  }
  if (Logic.hasTraffic(s, s.distance)) return Math.max(2, s.blueMark - 1); // 当前格有飞机，别前进
  var stepsLeft = s.altitude / cfg.ALTITUDE_STEP;
  if (s.distance >= stepsLeft) return Math.min(s.orangeMark + 1, 12);
  return s.blueMark;
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

function anythingOpen(s, role, Logic, v, allowSpentGear) {
  var slots = allSlots(role, Logic);
  for (var i = 0; i < slots.length; i++) {
    if (!allowSpentGear && isSpentGear(s, slots[i])) continue;
    if (Logic.getPlacement(s, role, slots[i]) !== null) continue;
    if (Logic.slotAllowed(s, role, slots[i], v).ok) return slots[i];
  }
  if (!allowSpentGear) return anythingOpen(s, role, Logic, v, true);
  return null;
}

/* ============================================================
 * 快速启发式决策（确定性、零克隆）
 * 用途：① 前瞻 rollout 里的双方模型；② laya 缺席时的兜底
 * ============================================================ */
/** 填必填槽时的目标值 */
function axisWant(s, role, you, axisSign, Logic, o) {
  if (o && o.prob && you.axis === null && SkyAIProb) {
    return SkyAIProb.bestAxisValue(
      s.axis, role, SkyAIProb.partnerFaces(s, role), Logic.isLandingRound(s)
    );
  }
  // 自然焦点：双方在没有沟通时最容易同时落在中值附近
  var own = clamp(3 + axisSign * s.axis, 1, 6);
  if (o && o.asOpponent) {
    // 对手模型：偶尔会配合跟随，多数时候按自己的中值偏好放
    var coop = (o.coop == null) ? 0.5 : o.coop;
    if (you.axis !== null && rnd() < coop) {
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
    var tgt = engineTargetSum(s, Logic, cfg, o && o.prob);
    want = (you.engine !== null) ? tgt - Logic.effVal(you.engine) : Math.round(tgt / 2);
    want = clamp(want, 1, 6);
  }
  return pickValue(s, role, Logic, slotName, want);
}

/* ============================================================
 * 快速启发式决策（确定性、零克隆）
 *
 * asOpponent=false（我方策略）：
 *   对手一旦放好姿态，立刻精确跟随；否则先把清障/设备/咖啡做掉，
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
    var rawAxis = Logic.effVal(you.axis) + axisSign * s.axis;
    if (rawAxis >= 1 && rawAxis <= 6) {
      var mA = pickValue(s, role, Logic, 'axis', rawAxis);
      if (mA) return mA;
    } else if (!(o && o.prob)) {
      var mClamp = pickValue(s, role, Logic, 'axis', clamp(rawAxis, 1, 6));
      if (mClamp) return mClamp;
    }
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
        if (lSlot) {
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
      clamp(engineTargetSum(s, Logic, cfg, o && o.prob) - Logic.effVal(you.engine), 1, 6));
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
    var mv = quickMove(s, r, Logic, cfg, { asOpponent: r !== opts.aiRole, coop: opts.coop, prob: opts.prob });
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
      var mv2 = quickMove(s, r2, Logic, cfg, { asOpponent: r2 !== opts.aiRole, coop: opts.coop, prob: opts.prob });
      if (!mv2) break;
      var res2 = Logic.placeDie(s, r2, mv2.dieIdx, mv2.slot, { coffeePlus: mv2.cp, coffeeMinus: mv2.cm });
      if (!res2 || !res2.ok) break;
      continue;
    }
    break;
  }
  return s;
}

/* ============================================================
 * 要事：只根据已经放在桌上的信息判断，不看对手未放的骰子。
 * 一条落子可以同时实现多件要事。咖啡和无目标的无线电不单独成件。
 * ============================================================ */
var PRIORITY_ORDER = ['match_axis', 'clear_hazard', 'landing_engine', 'equipment', 'fill_mandatory'];
var PRIORITY_LABEL = {
  match_axis: '配平姿态',
  clear_hazard: '清开挡路的飞机',
  landing_engine: '着陆压速',
  equipment: '补设备',
  fill_mandatory: '先填必填槽'
};

/** 精确配平值。做不到（对手没放、自己已放、或目标不在 1~6）则 null */
function exactAxisValue(s, role, Logic) {
  var opp = s.placements[otherRole(role)].axis;
  if (!opp || s.placements[role].axis) return null;
  var sign = role === 'pilot' ? 1 : -1;
  var raw = Logic.effVal(opp) + sign * s.axis;
  if (raw < 1 || raw > 6) return null;
  return raw;
}

/** 挡路的距离格：当前位置，以及按蓝/橙标记前进 1 或 2 格会经过的格子 */
function hazardDistances(s, Logic) {
  var cells = [];
  function add(d) {
    if (d >= 0 && Logic.hasTraffic(s, d) && cells.indexOf(d) === -1) cells.push(d);
  }
  add(s.distance);
  if (!Logic.isLandingRound(s) && !Logic.isWaitingMode(s)) {
    add(s.distance - 1);
    add(s.distance - 2);
  }
  if (Logic.isLandingRound(s)) {
    for (var v = 1; v <= 6; v++) add(Logic.radioTarget(s, v));
  }
  return cells;
}

function equipmentBehind(s, role, Logic, cfg) {
  var roundsLeft = Math.max(0, s.altitude / cfg.ALTITUDE_STEP);
  var work = role === 'pilot'
    ? (cfg.GEAR_COUNT - s.gearAct) + (cfg.BRAKE_COUNT - s.brakesAct)
    : (cfg.FLAP_COUNT - s.flapsAct);
  return work > roundsLeft * 2;
}

function mustFillNow(s, role) {
  var need = missingMandatory(s, role);
  return need.length > 0 && freeDice(s, role).length <= need.length;
}

function isEquipmentSlot(role, slot) {
  if (role === 'pilot') return slot.indexOf('gear') === 0 || slot.indexOf('brake') === 0;
  return slot.indexOf('flap') === 0;
}

function tagMove(s, role, Logic, cfg, move) {
  var tags = [];
  var axisT = exactAxisValue(s, role, Logic);
  if (axisT != null && move.slot === 'axis' && move.val === axisT) tags.push('match_axis');
  if (Logic.radioSlots(role).indexOf(move.slot) !== -1) {
    var hazards = hazardDistances(s, Logic);
    if (hazards.indexOf(Logic.radioTarget(s, move.val)) !== -1) tags.push('clear_hazard');
  }
  if (Logic.isLandingRound(s) && s.placements[role].engine === null && move.slot === 'engine') {
    tags.push('landing_engine');
  }
  if (equipmentBehind(s, role, Logic, cfg) && isEquipmentSlot(role, move.slot)) tags.push('equipment');
  if (mustFillNow(s, role) && (move.slot === 'axis' || move.slot === 'engine')) tags.push('fill_mandatory');
  return tags;
}

function primaryPriority(tags) {
  if (!tags) return null;
  for (var i = 0; i < PRIORITY_ORDER.length; i++) {
    if (tags.indexOf(PRIORITY_ORDER[i]) !== -1) return PRIORITY_ORDER[i];
  }
  return null;
}

function sameMove(a, b) {
  return a && b && a.dieIdx === b.dieIdx && a.slot === b.slot && a.val === b.val &&
    (a.cp || 0) === (b.cp || 0) && (a.cm || 0) === (b.cm || 0);
}

function activePriorities(ranked) {
  var present = {};
  for (var i = 0; i < ranked.length; i++) {
    var tags = ranked[i].priorities || [];
    for (var j = 0; j < tags.length; j++) present[tags[j]] = 1;
  }
  var out = [];
  for (var k = 0; k < PRIORITY_ORDER.length; k++) {
    if (present[PRIORITY_ORDER[k]]) out.push(PRIORITY_ORDER[k]);
  }
  return out;
}

function priorityDetail(s, role, Logic, cfg, id) {
  if (id === 'match_axis') {
    var opp = Logic.effVal(s.placements[otherRole(role)].axis);
    return '对手已放姿态 ' + opp + '，你可以把骰子放到 ' + exactAxisValue(s, role, Logic) + '，姿态回到 0';
  }
  if (id === 'clear_hazard') {
    return '距离 ' + hazardDistances(s, Logic).join('、') + ' 有飞机，无线电可以清除';
  }
  if (id === 'landing_engine') {
    return '着陆轮，你的引擎还没放，双方引擎和必须小于 ' + Logic.brakeValue(s);
  }
  if (id === 'equipment') {
    var left = role === 'pilot'
      ? '起落架还剩 ' + (cfg.GEAR_COUNT - s.gearAct) + '，刹车还剩 ' + (cfg.BRAKE_COUNT - s.brakesAct)
      : '襟翼还剩 ' + (cfg.FLAP_COUNT - s.flapsAct);
    return left + '，剩下的轮数已经不够再拖';
  }
  if (id === 'fill_mandatory') return '剩下的骰子只够放姿态和引擎';
  return PRIORITY_LABEL[id] || id;
}

function pickTied(ranked, opts) {
  if (!ranked.length) return null;
  var top = ranked[0].score;
  var ties = [];
  for (var i = 0; i < ranked.length; i++) {
    if (Math.abs(ranked[i].score - top) <= 1e-6) ties.push(ranked[i]);
  }
  var idx = (opts && opts.seed != null) ? (opts.seed % ties.length) : Math.floor(rnd() * ties.length);
  return ties[idx];
}

/** priorityId 为空时取全局最高分；该要事没有候选时退回全局搜索 */
function bestMove(ranked, priorityId, opts) {
  var pool = ranked;
  if (priorityId) {
    pool = [];
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].priorities && ranked[i].priorities.indexOf(priorityId) !== -1) pool.push(ranked[i]);
    }
    if (!pool.length) pool = ranked;
  }
  var hit = pickTied(pool, opts);
  return hit ? hit.move : null;
}

function ownPriority(ranked, move) {
  if (move) {
    for (var i = 0; i < ranked.length; i++) {
      if (sameMove(ranked[i].move, move)) return primaryPriority(ranked[i].priorities);
    }
  }
  return ranked.length ? primaryPriority(ranked[0].priorities) : null;
}

/** fair 模式：把对手「未放置」的骰子随机化（AI 不该看见它们） */
function blindOpponent(t, aiRole) {
  var o = otherRole(aiRole);
  var dice = t.dice[o];
  for (var i = 0; i < dice.length; i++) {
    if (!dice[i].used) dice[i].v = 1 + Math.floor(rnd() * 6);
  }
}

/* ============================================================
 * 完整版：枚举当前所有合法动作 → rollout → 评估 → 选优
 * ============================================================ */
function scoreFromParts(parts) {
  if (!parts) return 0;
  if (parts.kind === 'win') return WIN_SCORE;
  if (parts.kind === 'lose') return LOSE_SCORE + parts.side.total;
  return parts.total;
}

function probabilityScore(s, role, move, t, cfg, useDice) {
  return scoreFromParts(SkyAIProb.scoreParts(s, role, move, t, cfg, useDice));
}

function rankMoves(s, role, Logic, cfg, opts) {
  opts = opts || {};
  var moves = enumerateMoves(s, role, Logic, opts);
  var fair = opts.fair !== false;
  var samples = Math.max(1, opts.samples | 0 || 1);
  var beforeScore = SkyAIEvaluate.evaluate(s, Logic, cfg) * 0.01;
  var out = [];

  for (var i = 0; i < moves.length; i++) {
    var m = moves[i];
    var sum = 0, valid = false, lastParts = null;
    for (var k = 0; k < samples; k++) {
      var t = cloneState(s);
      if (fair) blindOpponent(t, role);
      var res = Logic.placeDie(t, role, m.dieIdx, m.slot, { coffeePlus: m.cp, coffeeMinus: m.cm });
      if (!res || !res.ok) break;
      var v;
      if (opts.prob && SkyAIProb) {
        if (t.phase !== 'lose' && t.phase !== 'win') {
          rollout(t, Logic, cfg, { toGameEnd: opts.toGameEnd, aiRole: role, coop: opts.coop, prob: opts.prob });
        }
        lastParts = SkyAIProb.scoreParts(s, role, m, t, cfg, !fair);
        v = scoreFromParts(lastParts);
      } else if (t.phase === 'lose') {
        v = LOSE_SCORE + beforeScore;
      } else if (t.phase === 'win') {
        v = WIN_SCORE;
      } else {
        rollout(t, Logic, cfg, { toGameEnd: opts.toGameEnd, aiRole: role, coop: opts.coop, prob: opts.prob });
        v = (t.phase === 'lose') ? LOSE_SCORE + beforeScore
          : (t.phase === 'win') ? WIN_SCORE
          : SkyAIEvaluate.evaluate(t, Logic, cfg);
      }
      sum += v; valid = true;
    }
    if (valid) out.push({
      move: m,
      score: sum / samples,
      parts: lastParts,
      priorities: tagMove(s, role, Logic, cfg, m)
    });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

function moveKey(m) {
  return m.dieIdx + '/' + m.slot + '/' + m.val + '/' + (m.cp || 0) + '/' + (m.cm || 0);
}

/** 每件要事只留评分最高的一手，再加无标签里最高的一手（咖啡等）。同一手不重复。 */
function macroArms(ranked, opts) {
  var arms = [], seen = {};
  function add(id, move) {
    if (!move) return;
    var key = moveKey(move);
    if (seen[key]) return;
    seen[key] = 1;
    var score = -Infinity;
    for (var i = 0; i < ranked.length; i++) {
      if (sameMove(ranked[i].move, move)) { score = ranked[i].score; break; }
    }
    arms.push({ id: id, move: move, score: score });
  }
  var active = activePriorities(ranked);
  for (var a = 0; a < active.length; a++) add(active[a], bestMove(ranked, active[a], opts));
  for (var j = 0; j < ranked.length; j++) {
    if (!ranked[j].priorities || !ranked[j].priorities.length) {
      add('none', ranked[j].move);
      break;
    }
  }
  arms.sort(function (x, y) { return y.score - x.score; });
  return arms;
}

function closeArms(arms, gap, maxArms) {
  if (!arms.length) return arms;
  var top = arms[0].score, out = [];
  for (var i = 0; i < arms.length && out.length < maxArms; i++) {
    if (top - arms[i].score <= gap) out.push(arms[i]);
  }
  return out;
}

function positionSeed(s, role) {
  var h = 2166136261;
  function mix(n) { h ^= (n | 0); h = Math.imul(h, 16777619); }
  mix(s.round); mix(s.axis); mix(s.distance); mix(Math.round(s.altitude));
  mix(s.coffee); mix(role === 'pilot' ? 1 : 2);
  var dice = s.dice[role] || [];
  for (var i = 0; i < dice.length; i++) mix(dice[i].used ? 0 : (dice[i].v || 0));
  return (h >>> 0) || 1;
}

function withGameRandom(seed, fn) {
  var prev = Math.random;
  var st = (seed >>> 0) || 1;
  Math.random = function () {
    st ^= st << 13; st >>>= 0;
    st ^= st >>> 17;
    st ^= st << 5; st >>>= 0;
    return st / 4294967296;
  };
  try { return fn(); }
  finally { Math.random = prev; }
}

function heuristicOpts(opts) {
  return {
    fair: opts.fair,
    coop: opts.coop,
    samples: opts.samples,
    seed: opts.seed,
    toGameEnd: opts.toGameEnd,
    enforceMandatory: opts.enforceMandatory,
    macro: false,
    prob: opts.prob
  };
}

function forkArm(s, role, Logic, opts, seed, move) {
  return withGameRandom(seed, function () {
    var t = cloneState(s);
    var placed = Logic.placeDie(t, role, move.dieIdx, move.slot, {
      coffeePlus: move.cp, coffeeMinus: move.cm
    });
    if (!placed || !placed.ok) return null;
    return playHeuristic(t, Logic, opts);
  });
}

/** 终局推演用原来的评分选子，不再进入宏观选择，否则会套娃。 */
function playHeuristic(s, Logic, opts) {
  var inner = heuristicOpts(opts);
  var guard = 0;
  while (s.phase !== 'win' && s.phase !== 'lose' && guard++ < 400) {
    if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
    if (s.phase === 'roll') {
      Logic.rollDice(s, 'pilot');
      Logic.rollDice(s, 'copilot');
      s.phase = 'place';
      s.currentPlayer = s.startPlayer;
      continue;
    }
    if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
    if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }
    if (s.phase !== 'place') break;
    applyReroll(s, Logic);
    var r = s.currentPlayer;
    var cfg = Logic.getScenarioConfig(s);
    var mv = searchBestMove(s, r, Logic, cfg, inner);
    if (!mv) break;
    var res = Logic.placeDie(s, r, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    if (!res || !res.ok) break;
  }
  return s.phase === 'win';
}

var macroStats = { points: 0, forked: 0, switched: 0, kept: 0 };
function resetMacroStats() {
  macroStats.points = 0;
  macroStats.forked = 0;
  macroStats.switched = 0;
  macroStats.kept = 0;
}

/**
 * 先在要事之间选一件，再下那件里评分最高的骰子。
 * 代表手的分数差得很开时信评分；贴得近才用同一批未来骰子打到终局。
 * 领先不够（默认 8 局里净胜不足 2）就仍下评分最高的那手，避免噪声改棋。
 */
function forkWins(s, role, Logic, opts, arms) {
  var M = (opts.macroSamples != null) ? opts.macroSamples : 8;
  var seedBase = positionSeed(s, role);
  var wins = [];
  for (var a = 0; a < arms.length; a++) wins.push(0);
  var n = 0;
  for (var k = 0; k < M; k++) {
    var seed = (seedBase + k * 7919) >>> 0 || 1;
    var results = [];
    var ok = true;
    for (var i = 0; i < arms.length; i++) {
      var hit = forkArm(s, role, Logic, opts, seed, arms[i].move);
      if (hit === null) { ok = false; break; }
      results.push(!!hit);
    }
    if (!ok) continue;
    n++;
    for (var w = 0; w < results.length; w++) if (results[w]) wins[w]++;
  }
  return { wins: wins, n: n, M: M };
}

function macroChoose(s, role, Logic, ranked, opts) {
  var gap = (opts.macroGap != null) ? opts.macroGap : 4000;
  var maxArms = (opts.macroMax != null) ? opts.macroMax : 3;
  var all = macroArms(ranked, opts);
  var arms = closeArms(all, gap, maxArms);
  if (typeof opts.onWide === 'function' && all.length >= 2 && arms.length < 2) {
    opts.onWide(s, role, all);
  }
  if (arms.length < 2) return arms.length ? arms[0].move : null;

  var margin = (opts.macroMargin != null) ? opts.macroMargin : 2;
  macroStats.forked++;
  var fork = forkWins(s, role, Logic, opts, arms);
  var wins = fork.wins;
  var bestI = 0, second = -1;
  for (var u = 1; u < wins.length; u++) if (wins[u] > wins[bestI]) bestI = u;
  for (var v = 0; v < wins.length; v++) if (v !== bestI && wins[v] > second) second = wins[v];
  var lead = wins[bestI] - (second < 0 ? 0 : second);
  if (fork.n < fork.M || lead < margin) {
    macroStats.kept++;
    return arms[0].move;
  }
  if (moveKey(arms[bestI].move) !== moveKey(arms[0].move)) macroStats.switched++;
  return arms[bestI].move;
}

function searchDecision(s, role, Logic, cfg, opts) {
  opts = opts || {};
  var ranked = rankMoves(s, role, Logic, cfg, opts);
  var mv = null;
  if (opts.macro) {
    macroStats.points++;
    mv = macroChoose(s, role, Logic, ranked, opts);
  }
  if (!mv) mv = bestMove(ranked, null, opts);
  var entry = null;
  if (mv) {
    for (var i = 0; i < ranked.length; i++) {
      if (sameMove(ranked[i].move, mv)) { entry = ranked[i]; break; }
    }
  }
  var top = ranked.length ? ranked[0] : null;
  return {
    move: mv,
    priority: mv ? ownPriority(ranked, mv) : null,
    parts: entry && entry.parts,
    score: entry ? entry.score : null,
    top: top && !(mv && sameMove(top.move, mv)) ? top : null
  };
}

function searchBestMove(s, role, Logic, cfg, opts) {
  return searchDecision(s, role, Logic, cfg, opts).move;
}

/* 重掷只看自己的骰。能进设备、能清飞机、能压住已放的姿态、或落后时能帮引擎走两格的留下。
 * 对方还没放姿态时，只留一颗最接近安全点数的。 */
function keepDie(s, role, idx, Logic) {
  var die = s.dice[role][idx];
  var v = die.v;
  var slots = Logic.SLOTS[role];
  var names = Object.keys(slots);
  for (var i = 0; i < names.length; i++) {
    var slot = names[i];
    if (slot === 'axis' || slot === 'engine' || slot === 'radio' || slot === 'radio2') continue;
    var def = slots[slot];
    if (def.gear && s.gearOn && s.gearOn[slot]) continue;
    if (Logic.slotAllowed(s, role, slot, v).ok) return true;
  }
  var planes = s.traffic || [];
  for (var p = 0; p < planes.length; p++) {
    if (s.distance - (v - 1) === planes[p]) return true;
  }
  var you = s.placements[otherRole(role)];
  var coffee = s.coffee || 0;
  if (you && you.axis) {
    var sign = role === 'pilot' ? 1 : -1;
    var raw = Logic.effVal(you.axis) + sign * s.axis;
    if (raw >= 1 && raw <= 6 && Math.abs(v - raw) <= coffee) return true;
  } else if (idx === axisKeeper(s, role)) {
    return true;
  }
  if (distanceBehind(s) > 0 && v >= 4) return true;
  return false;
}

function distanceBehind(s) {
  return SkyAIProb ? SkyAIProb.distanceBehind(s) : 0;
}

function axisKeeper(s, role) {
  if (!SkyAIProb) return -1;
  var target = SkyAIProb.bestAxisValue(s.axis, role, null, !!s.landingRound);
  var dice = s.dice[role] || [];
  var best = -1;
  var bestDist = 99;
  for (var i = 0; i < dice.length; i++) {
    if (dice[i].used || !(dice[i].v > 0)) continue;
    var dist = Math.abs(dice[i].v - target);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function rerollIndices(s, role, Logic) {
  var dice = (s.dice && s.dice[role]) || [];
  var junk = [];
  for (var i = 0; i < dice.length; i++) {
    if (dice[i].used || !(dice[i].v > 0)) continue;
    if (!keepDie(s, role, i, Logic)) junk.push(i);
  }
  return junk;
}

function dieFaces(s, role) {
  return (s.dice[role] || []).map(function (d) { return d.v; });
}

/** 至少两颗没法用才消耗 1 枚。双方各自只重掷自己用不上的。 */
function applyReroll(s, Logic) {
  if (!s || s.reroll <= 0 || !s.currentPlayer) return null;
  if (s.phase !== 'place' && s.phase !== 'roll') return null;
  if (s.rerollPick && s.rerollPick.active) return null;
  if (rerollIndices(s, s.currentPlayer, Logic).length < 2) return null;
  var before = { pilot: dieFaces(s, 'pilot'), copilot: dieFaces(s, 'copilot') };
  var picks = {
    pilot: rerollIndices(s, 'pilot', Logic),
    copilot: rerollIndices(s, 'copilot', Logic)
  };
  var began = Logic.beginReroll(s);
  if (!began || !began.ok) return null;
  Logic.submitRerollPick(s, 'pilot', picks.pilot);
  Logic.submitRerollPick(s, 'copilot', picks.copilot);
  var after = { pilot: dieFaces(s, 'pilot'), copilot: dieFaces(s, 'copilot') };
  return { before: before, after: after, picks: picks, left: s.reroll };
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
      if (s.rerollPick && s.rerollPick.active) {
        if (s.rerollPick[role] == null) {
          return { name: 'reroll-pick', args: [rerollIndices(s, role, Logic)] };
        }
        return null;
      }
      if (s.currentPlayer === role && s.reroll > 0 && rerollIndices(s, role, Logic).length >= 2) {
        return { name: 'begin-reroll', args: [] };
      }
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
  setRng: setRng,
  rankMoves: rankMoves,
  quickMove: quickMove,
  enumerateMoves: enumerateMoves,
  searchBestMove: searchBestMove,
  searchDecision: searchDecision,
  applyReroll: applyReroll,
  rerollIndices: rerollIndices,
  macroStats: macroStats,
  resetMacroStats: resetMacroStats,
  forkWins: forkWins,
  bestMove: bestMove,
  activePriorities: activePriorities,
  ownPriority: ownPriority,
  priorityDetail: priorityDetail,
  exactAxisValue: exactAxisValue,
  hazardDistances: hazardDistances,
  PRIORITY_ORDER: PRIORITY_ORDER,
  PRIORITY_LABEL: PRIORITY_LABEL,
  rollout: rollout,
  engineTargetSum: engineTargetSum,
  radioNeededValue: radioNeededValue
};
if (typeof module !== 'undefined' && module.exports) module.exports = Planner;
if (typeof window !== 'undefined') window.SkyAIPlanner = Planner;
