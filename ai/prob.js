/* ============================================================
 * 姿态、引擎和本回合操作的概率。
 *
 * 姿态：看不见点数时，坠毁概率 = (不安全面数 / 6) ^ 剩余骰子数。
 * 引擎：先按高度和距离的差选走 0、1、2 格，再看这一档配不配得出。
 * 咖啡和重掷不加分。
 * ============================================================ */
'use strict';

var HANDS = [];
(function () {
  for (var i = 0; i < 1296; i++) {
    HANDS.push([
      (i % 6) + 1,
      ((i / 6) | 0) % 6 + 1,
      ((i / 36) | 0) % 6 + 1,
      ((i / 216) | 0) % 6 + 1
    ]);
  }
})();

var STEP_CACHE = {};

function stepHist(blue, orange) {
  var key = blue + '/' + orange;
  if (STEP_CACHE[key]) return STEP_CACHE[key];
  var buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  for (var i = 0; i < 1296; i++) {
    var A = HANDS[i];
    for (var j = 0; j < 1296; j++) {
      var B = HANDS[j];
      var mask = 0;
      for (var a = 0; a < 4; a++) {
        for (var b = 0; b < 4; b++) {
          var es = A[a] + B[b];
          var k = es < blue ? 0 : (es <= orange ? 1 : 2);
          mask |= (1 << k);
        }
      }
      buckets[mask]++;
    }
  }
  STEP_CACHE[key] = { buckets: buckets, total: 1296 * 1296 };
  return STEP_CACHE[key];
}

function stepTrans(blue, orange, want) {
  var h = stepHist(blue, orange);
  var crash = 0, k0 = 0, k1 = 0, k2 = 0;
  for (var mask = 0; mask < 8; mask++) {
    var n = h.buckets[mask];
    if (!n) continue;
    var can0 = mask & 1, can1 = mask & 2, can2 = mask & 4;
    var k = -1;
    if (want === 2) k = can2 ? 2 : can1 ? 1 : can0 ? 0 : -1;
    else if (want === 1) k = can1 ? 1 : can0 ? 0 : can2 ? 2 : -1;
    else k = can0 ? 0 : -1;
    if (k < 0) crash += n;
    else if (k === 0) k0 += n;
    else if (k === 1) k1 += n;
    else k2 += n;
  }
  var t = h.total;
  return [crash / t, k0 / t, k1 / t, k2 / t];
}

/** 以后各轮按「落后就争取走 2、正好或超前就走 1、已到机场就悬停」能活到落地的概率 */
function travelSurvival(distance, roundsLeft, blue, orange) {
  if (roundsLeft <= 0) return distance === 0 ? 1 : 0;
  if (distance > roundsLeft * 2) return 0;
  blue = blue == null ? 5 : blue;
  orange = orange == null ? 8 : orange;
  var maxD = Math.max(distance, roundsLeft * 2);
  if (maxD > 12) maxD = 12;
  var prev = [];
  for (var d = 0; d <= maxD; d++) prev[d] = 0;
  prev[distance] = 1;
  var trans = [
    stepTrans(blue, orange, 0),
    stepTrans(blue, orange, 1),
    stepTrans(blue, orange, 2)
  ];
  for (var r = roundsLeft; r > 0; r--) {
    var next = [];
    for (var z = 0; z <= maxD; z++) next[z] = 0;
    for (var dist = 0; dist <= maxD; dist++) {
      var mass = prev[dist];
      if (!mass) continue;
      var want = dist === 0 ? 0 : (dist > r ? 2 : 1);
      var tr = trans[want];
      for (var k = 0; k <= 2; k++) {
        var nd = dist - k;
        if (nd < 0 || nd > maxD) continue;
        next[nd] += mass * tr[k + 1];
      }
    }
    prev = next;
  }
  return prev[0] || 0;
}

function newAxis(axis, role, own, opp) {
  var pa = role === 'pilot' ? own : opp;
  var ca = role === 'pilot' ? opp : own;
  var diff = Math.abs(pa - ca);
  return axis + (pa > ca ? -diff : diff);
}

function faceList(faces) {
  if (!faces || !faces.length) {
    return [1, 2, 3, 4, 5, 6];
  }
  return faces;
}

/** 对方还没放时，我放 own 之后不尾旋的概率。faces 为空则 1~6 均匀。 */
function axisSafeProb(axis, role, own, faces) {
  var list = faceList(faces);
  var ok = 0;
  for (var i = 0; i < list.length; i++) {
    if (Math.abs(newAxis(axis, role, own, list[i])) < 3) ok++;
  }
  return ok / list.length;
}

function axisIsSafe(axis, role, own, opp, landing) {
  var next = newAxis(axis, role, own, opp);
  if (landing) return next === 0;
  return Math.abs(next) < 3;
}

/** 看不见点数时，坠毁概率 = (不安全面数 / 6) ^ 剩余骰子数。看见了，有一颗安全就是 0。 */
function axisCrashProb(axis, role, own, nDice, faces, landing) {
  if (faces && faces.length) {
    for (var i = 0; i < faces.length; i++) {
      if (axisIsSafe(axis, role, own, faces[i], landing)) return 0;
    }
    return 1;
  }
  var n = nDice > 0 ? nDice : 4;
  var bad = 0;
  for (var p = 1; p <= 6; p++) {
    if (!axisIsSafe(axis, role, own, p, landing)) bad++;
  }
  return Math.pow(bad / 6, n);
}

function axisLevelProb(axis, role, own, faces) {
  var list = faceList(faces);
  var ok = 0;
  for (var i = 0; i < list.length; i++) {
    if (newAxis(axis, role, own, list[i]) === 0) ok++;
  }
  return ok / list.length;
}

function bestAxisValue(axis, role, faces, landing) {
  var bestV = 3, bestR = 2;
  var n = faces && faces.length ? faces.length : 4;
  for (var v = 1; v <= 6; v++) {
    var r = axisCrashProb(axis, role, v, n, faces, !!landing);
    var better = r < bestR - 1e-15;
    var tie = Math.abs(r - bestR) <= 1e-15 && Math.abs(v - 3.5) < Math.abs(bestV - 3.5);
    if (better || tie) { bestR = r; bestV = v; }
  }
  return bestV;
}

function partnerDiceCount(s, role) {
  var dice = s.dice[role === 'pilot' ? 'copilot' : 'pilot'] || [];
  var n = 0;
  for (var i = 0; i < dice.length; i++) {
    if (!dice[i].used) n++;
  }
  return n || 4;
}

function partnerFaces(s, role) {
  var dice = s.dice[role === 'pilot' ? 'copilot' : 'pilot'] || [];
  var faces = [];
  for (var i = 0; i < dice.length; i++) {
    if (!dice[i].used && dice[i].v > 0) faces.push(dice[i].v);
  }
  return faces.length ? faces : null;
}

function roundsLeft(s, cfg) {
  var step = (cfg && cfg.ALTITUDE_STEP) || 1000;
  return Math.max(0, Math.round((s.altitude || 0) / step));
}

/** 我放 1，对方 4 颗都配不出「和 < 蓝」的概率。蓝 5 时是 1/16。 */
function hoverMiss(blue) {
  var safe = Math.min(6, (blue || 5) - 2);
  if (safe >= 6) return 0;
  if (safe < 1) return 1;
  return Math.pow((6 - safe) / 6, 4);
}

/** 我放 6，对方 4 颗都配不出「和 > 橙」的概率。橙到 12 时是 1。 */
function doubleMiss(orange) {
  orange = orange || 8;
  if (orange >= 12) return 1;
  var need = orange - 5;
  if (need < 1) need = 1;
  if (need > 6) return 1;
  var safe = 6 - need + 1;
  return Math.pow((6 - safe) / 6, 4);
}

/** 要在 rounds 次里做成 debt 次。次数不够是 1；只欠 1 次、还能试很多轮，就是单次失败概率的乘方。 */
function payRisk(miss, debt, rounds) {
  if (debt <= 0) return 0;
  if (rounds < debt) return 1;
  if (miss >= 1) return 1;
  var slack = rounds - debt + 1;
  if (debt === 1) return Math.pow(miss, slack);
  if (rounds === debt) return 1 - Math.pow(1 - miss, debt);
  return Math.pow(miss, slack);
}

function unusedFaces(s) {
  var out = [];
  ['pilot', 'copilot'].forEach(function (r) {
    var dice = (s.dice && s.dice[r]) || [];
    for (var i = 0; i < dice.length; i++) {
      if (!dice[i].used && dice[i].v > 0) out.push(dice[i].v);
    }
  });
  return out;
}

function dieClears(distance, die, plane) {
  return distance - (die - 1) === plane;
}

/** 走 k 格会把还没清掉的飞机留在身后，或带着脚下的飞机前进。 */
function strandsPlane(s, k) {
  if (k <= 0) return false;
  var d = s.distance;
  var dest = d - k;
  var faces = unusedFaces(s);
  var list = s.traffic || [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var jumped = (p === d) || (p < d && p > dest);
    if (!jumped) continue;
    var cleared = false;
    for (var j = 0; j < faces.length; j++) {
      if (dieClears(d, faces[j], p)) { cleared = true; break; }
    }
    if (!cleared) return true;
  }
  return false;
}

/**
 * 从现在的高度、距离走 k 格的进度风险。
 * 新差 = (剩余下降 − 距离) + (k − 1)。差变 0 是 0；多出的悬停和补不上的两格分开算。
 */
function stepRisk(s, k, cfg) {
  if (k < 0 || k > 2) return 1;
  if (s.landingRound) return k === 0 ? 0 : 1;
  if (s.distance === 0) return k === 0 ? 0 : 1;
  if (k > s.distance) return 1;
  var orange = s.orangeMark == null ? 8 : s.orangeMark;
  var blue = s.blueMark == null ? 5 : s.blueMark;
  if (k === 2 && orange >= 12) return 1;
  if (strandsPlane(s, k)) return 1;
  var n = roundsLeft(s, cfg);
  var gap = (n - s.distance) + (k - 1);
  var left = n - 1;
  if (gap === 0) return 0;
  if (gap > 0) return payRisk(hoverMiss(blue), gap, left);
  return payRisk(doubleMiss(orange), -gap, left);
}

function bestStep(s, cfg) {
  var bestK = 1, bestR = 2;
  for (var k = 0; k <= 2; k++) {
    var r = stepRisk(s, k, cfg);
    var closer = Math.abs(k - 1) < Math.abs(bestK - 1);
    if (r < bestR - 1e-15 || (Math.abs(r - bestR) <= 1e-15 && closer)) {
      bestR = r;
      bestK = k;
    }
  }
  return bestK;
}

function hoverMissParts(blue) {
  var safe = Math.min(6, (blue || 5) - 2);
  if (safe >= 6) return { p: 0, bad: 0 };
  if (safe < 1) return { p: 1, bad: 6 };
  var bad = 6 - safe;
  return { p: Math.pow(bad / 6, 4), bad: bad };
}

function doubleMissParts(orange) {
  orange = orange || 8;
  if (orange >= 12) return { p: 1, bad: 6, orange: orange };
  var need = orange - 5;
  if (need < 1) need = 1;
  if (need > 6) return { p: 1, bad: 6, orange: orange };
  var safe = 6 - need + 1;
  var bad = 6 - safe;
  return { p: Math.pow(bad / 6, 4), bad: bad, orange: orange };
}

function payRiskParts(miss, debt, rounds) {
  var out = { miss: miss, debt: debt, rounds: rounds, slack: rounds - debt + 1 };
  if (debt <= 0) { out.p = 0; out.how = 'none'; return out; }
  if (rounds < debt) { out.p = 1; out.how = 'short'; return out; }
  if (miss >= 1) { out.p = 1; out.how = 'certain'; return out; }
  if (debt === 1) { out.p = Math.pow(miss, out.slack); out.how = 'once'; return out; }
  if (rounds === debt) { out.p = 1 - Math.pow(1 - miss, debt); out.how = 'exact'; return out; }
  out.p = Math.pow(miss, out.slack);
  out.how = 'power';
  return out;
}

function boardFields(s) {
  return {
    altitude: s.altitude,
    distance: s.distance,
    axis: s.axis,
    blue: s.blueMark,
    orange: s.orangeMark
  };
}

/** 走完这一轮之后的航程坠毁概率，以及差、标记、单次失败概率。 */
function progressParts(s, cfg) {
  var out = s ? boardFields(s) : {};
  if (!s || s.phase === 'win') { out.p = 0; out.how = 'win'; return out; }
  if (s.phase === 'lose') { out.p = 1; out.how = 'lose'; return out; }
  if (Math.abs(s.axis) >= 3) { out.p = 1; out.how = 'spin'; return out; }
  if (s.distance < 0) { out.p = 1; out.how = 'overshoot'; return out; }
  var list = s.traffic || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] > s.distance) { out.p = 1; out.how = 'behind'; out.plane = list[i]; return out; }
  }
  if (s.landingRound) {
    if (s.axis !== 0 || s.distance !== 0) { out.p = 1; out.how = 'landing'; return out; }
    out.p = 0; out.how = 'landing-ok'; return out;
  }
  var n = roundsLeft(s, cfg);
  out.n = n;
  if (n === 0 && s.distance !== 0) { out.p = 1; out.how = 'altitude'; return out; }
  if (s.distance === 0) {
    var hoverAll = hoverMissParts(s.blueMark);
    var payAll = payRiskParts(hoverAll.p, n, n);
    out.p = payAll.p; out.how = 'hover-out'; out.miss = hoverAll; out.pay = payAll; return out;
  }
  var gap = n - s.distance;
  out.gap = gap;
  if (gap === 0) { out.p = 0; out.how = 'even'; return out; }
  if (gap > 0) {
    var hover = hoverMissParts(s.blueMark);
    var pay = payRiskParts(hover.p, gap, n);
    out.p = pay.p; out.how = 'hover'; out.miss = hover; out.pay = pay; return out;
  }
  var dbl = doubleMissParts(s.orangeMark);
  var payBack = payRiskParts(dbl.p, -gap, n);
  out.p = payBack.p; out.how = 'double'; out.miss = dbl; out.pay = payBack; return out;
}

/** 走完这一轮之后，还欠的悬停或两格。飞机已经落到身后则是 1。 */
function progressRisk(s, cfg) {
  return progressParts(s, cfg).p;
}

/**
 * 这一手的副分。清飞机的距离 = 自己所在格 − 飞机所在格。
 * 机长：距离 0 为 5000，每远一格 −2000，最低 1000。
 * 副驾：距离 0 为 5000，每远一格 −1000，最低 1000。
 * 格内一架不加，每多一架 +500。一次无线电只清一架。
 * 先手姿态（对方还没放）4000，后手姿态 0。
 * 引擎从不落后起每格 2500：不落后 2500，落后 N 格为 2500 × (N + 1)。着陆轮不加。
 * 起落架按已开启个数：第 1 个 3000，第 2、第 3 个 2500。已激活的槽再放是 0。
 */
function distanceBehind(s) {
  if (!s || s.landingRound) return 0;
  var n = roundsLeft(s);
  var behind = (s.distance || 0) - n;
  return behind > 0 ? behind : 0;
}

function sideParts(s, role, move) {
  var out = {
    spend: 0, spendPoints: 0, coffeeGain: 0, flap: 0, gear: 0, brake: 0, radio: 0,
    axis: 0, engine: 0, behind: 0, axisLead: false,
    slotKind: 'none', total: 0
  };
  if (!s || !move) return out;
  out.spend = (move.cp || 0) + (move.cm || 0);
  out.spendPoints = -out.spend * 1000;
  var score = out.spendPoints;
  var slot = move.slot || '';
  if (slot === 'axis') {
    out.slotKind = 'axis';
    var you = s.placements[role === 'pilot' ? 'copilot' : 'pilot'];
    out.axisLead = !(you && you.axis);
    if (out.axisLead) out.axis = 4000;
    score += out.axis;
  } else if (slot === 'engine') {
    out.slotKind = 'engine';
    out.behind = distanceBehind(s);
    out.landing = !!s.landingRound;
    if (!out.landing) out.engine = 2500 * (out.behind + 1);
    score += out.engine;
  } else if (slot.indexOf('coffee') === 0) {
    out.slotKind = 'coffee';
    out.coffeeNow = s.coffee || 0;
    if (out.coffeeNow < 3) { out.coffeeGain = 1500; score += 1500; }
  } else if (slot.indexOf('flap') === 0) {
    out.slotKind = 'flap';
    out.flapN = +slot.replace('flap', '');
    out.flapOn = !!(s.flapsOn && s.flapsOn[slot]);
    var flapPts = [0, 3000, 2500, 2000, 1500];
    if (!out.flapOn) out.flap = flapPts[out.flapN] || 0;
    score += out.flap;
  } else if (slot.indexOf('gear') === 0) {
    out.slotKind = 'gear';
    out.gearOn = !!(s.gearOn && s.gearOn[slot]);
    out.gearN = (s.gearAct || 0) + 1;
    var gearPts = [0, 3000, 2500, 2500];
    if (!out.gearOn) out.gear = gearPts[out.gearN] || 0;
    score += out.gear;
  } else if (slot.indexOf('brake') === 0) {
    out.slotKind = 'brake';
    out.brakeN = +slot.replace('brake', '');
    out.brakeOn = !!(s.brakesOn && s.brakesOn[slot]);
    var brakePts = [0, 3500, 3000, 2500];
    if (!out.brakeOn) out.brake = brakePts[out.brakeN] || 0;
    score += out.brake;
  } else if (slot === 'radio' || slot === 'radio2') {
    out.slotKind = 'radio';
    out.clearDist = move.val - 1;
    out.planeAt = s.distance - out.clearDist;
    out.count = 0;
    var list = s.traffic || [];
    for (var i = 0; i < list.length; i++) if (list[i] === out.planeAt) out.count++;
    out.step = role === 'pilot' ? 2000 : 1000;
    out.raw = 5000 - out.clearDist * out.step;
    out.base = Math.max(1000, out.raw);
    if (out.count) {
      out.bonus = Math.max(0, out.count - 1) * 500;
      out.radio = out.base + out.bonus;
      score += out.radio;
    }
  }
  out.total = score;
  return out;
}

function sideScore(s, role, move) {
  return sideParts(s, role, move).total;
}

function scoreParts(s, role, move, t, cfg, useDice) {
  var side = sideParts(s, role, move);
  if (t && t.phase === 'win') return { kind: 'win', side: side };
  if (t && t.phase === 'lose') return { kind: 'lose', side: side };
  var axis = axisParts(s, role, move, useDice);
  var prog = progressParts(t, cfg);
  var survive = (1 - axis.p) * (1 - prog.p);
  if (survive < 0) survive = 0;
  if (survive > 1) survive = 1;
  var main = survive * 100000;
  return { kind: 'play', axis: axis, prog: prog, main: main, side: side, total: main + side.total };
}

/** 这一回合用骰子做成的操作：襟翼、起落架、刹车，以及清掉的飞机。咖啡不算。 */
function roundOperations(before, after) {
  if (!before || !after) return 0;
  var ops = 0;
  ops += Math.max(0, (after.flapsAct || 0) - (before.flapsAct || 0));
  ops += Math.max(0, (after.gearAct || 0) - (before.gearAct || 0));
  ops += Math.max(0, (after.brakesAct || 0) - (before.brakesAct || 0));
  ops += Math.max(0, ((before.traffic || []).length) - ((after.traffic || []).length));
  return ops;
}

function placedNum(token) {
  if (!token) return null;
  var n = (token.v || 0) + (token.mod || 0);
  if (n < 1) n = 1;
  if (n > 6) n = 6;
  return n;
}

function reachable(v, coffee) {
  var lo = Math.max(1, v - coffee);
  var hi = Math.min(6, v + coffee);
  var out = [];
  for (var x = lo; x <= hi; x++) out.push(x);
  return out;
}

function axisTerm(s, role, own, useDice, landing) {
  var you = s.placements[role === 'pilot' ? 'copilot' : 'pilot'];
  var faces = useDice ? partnerFaces(s, role) : null;
  var oppPlaced = placedNum(you && you.axis);
  var term = { own: own, landing: !!landing, axis: s.axis };
  if (oppPlaced != null) {
    var next = newAxis(s.axis, role, own, oppPlaced);
    term.seen = true;
    term.opp = oppPlaced;
    term.next = next;
    term.p = landing ? (next === 0 ? 0 : 1) : (Math.abs(next) >= 3 ? 1 : 0);
    return term;
  }
  var n = faces && faces.length ? faces.length : partnerDiceCount(s, role);
  term.n = n;
  if (faces && faces.length) {
    term.faces = faces.slice();
    term.safe = false;
    for (var i = 0; i < faces.length; i++) {
      if (axisIsSafe(s.axis, role, own, faces[i], landing)) term.safe = true;
    }
    term.p = term.safe ? 0 : 1;
    return term;
  }
  term.bad = [];
  for (var p = 1; p <= 6; p++) {
    if (!axisIsSafe(s.axis, role, own, p, landing)) term.bad.push(p);
  }
  term.p = Math.pow(term.bad.length / 6, n);
  return term;
}

/** 姿态坠毁概率，以及公式用到的面数、剩余骰子。 */
function axisParts(s, role, move, useDice) {
  var landing = !!s.landingRound;
  var me = s.placements[role];
  if (move && move.slot === 'axis') {
    var placed = axisTerm(s, role, move.val, useDice, landing);
    placed.how = 'place';
    return placed;
  }
  if (me && me.axis) {
    var kept = axisTerm(s, role, placedNum(me.axis), useDice, landing);
    kept.how = 'placed';
    return kept;
  }
  var coffee = Math.max(0, (s.coffee || 0) - ((move && move.cp) || 0) - ((move && move.cm) || 0));
  var dice = s.dice[role] || [];
  var best = null;
  for (var i = 0; i < dice.length; i++) {
    if (dice[i].used || !(dice[i].v > 0)) continue;
    if (move && move.slot !== 'axis' && move.dieIdx === i) continue;
    var vals = reachable(dice[i].v, coffee);
    for (var j = 0; j < vals.length; j++) {
      var term = axisTerm(s, role, vals[j], useDice, landing);
      if (!best || term.p < best.p) {
        term.how = 'best';
        term.face = dice[i].v;
        term.coffee = coffee;
        best = term;
      }
    }
  }
  if (!best) return { how: 'none', p: 1, landing: !!landing, axis: s.axis };
  return best;
}

/**
 * 这一手对姿态坠毁概率的影响。
 * 着陆轮看能不能回到 0；前 6 轮看会不会尾旋。
 * useDice：看得到对方未放的点数时，用那几颗骰子代替 1~6。
 */
function axisMoveRisk(s, role, move, useDice) {
  return axisParts(s, role, move, useDice).p;
}

function controlScore(s) {
  return (s.flapsAct || 0) + (s.gearAct || 0) + (s.brakesAct || 0);
}

function trafficRisk(s) {
  var list = s.traffic || [];
  var fail = 0;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    var one = (d === s.distance && s.distance > 0) ? 0.25 : (d < s.distance && d >= 0 ? 0.1 : 0);
    fail = 1 - (1 - fail) * (1 - one);
  }
  return fail;
}

/** 局面在后续轮次坠毁的概率。0 是稳，1 是已经或必然坠毁。 */
function crashProb(s, cfg) {
  cfg = cfg || {};
  if (s.phase === 'win') return 0;
  if (s.phase === 'lose') return 1;
  if (Math.abs(s.axis) >= 3) return 1;
  if (s.distance < 0) return 1;

  var step = cfg.ALTITUDE_STEP || 1000;
  var roundsLeft = Math.max(0, Math.round(s.altitude / step));
  var placeRounds = s.landingRound ? 1 : roundsLeft + 1;
  var flapsLeft = (cfg.FLAP_COUNT || 4) - (s.flapsAct || 0);
  var gearLeft = (cfg.GEAR_COUNT || 3) - (s.gearAct || 0);
  var brakeLeft = (cfg.BRAKE_COUNT || 3) - (s.brakesAct || 0);
  var pilotWork = gearLeft + brakeLeft;
  if (flapsLeft > placeRounds * 2 || pilotWork > placeRounds * 2) return 1;
  if (s.landingRound && (flapsLeft > 0 || gearLeft > 0 || (s.traffic && s.traffic.length) || s.axis !== 0 || s.distance !== 0)) {
    return 1;
  }

  var travel = 1;
  if (!s.landingRound) {
    if (s.altitude === 0 && s.distance !== 0) return 1;
    if (s.altitude === 0 && s.distance === 0) travel = 1;
    else travel = travelSurvival(s.distance, roundsLeft, s.blueMark, s.orangeMark);
  }

  var brakesPossible = Math.min(cfg.BRAKE_COUNT || 3, (s.brakesAct || 0) + (s.landingRound ? 0 : placeRounds));
  var limits = [2, 3, 5, 7];
  var lim = limits[Math.max(0, Math.min(3, brakesPossible))];
  var speed = lim <= 2 ? 1 : (1 - travelSurvivalSpeed(lim));

  var fail = 1 - travel * (1 - trafficRisk(s)) * (1 - speed * 0.5);
  if (fail < 0) fail = 0;
  if (fail > 1) fail = 1;
  return fail;
}

/** 着陆时两边各拿最小的骰子，和仍然 ≥ 刹车值的概率 */
function travelSurvivalSpeed(limit) {
  var dist = [0, 0, 0, 0, 0, 0, 0];
  for (var i = 0; i < 1296; i++) {
    var h = HANDS[i];
    var m = h[0];
    for (var k = 1; k < 4; k++) if (h[k] < m) m = h[k];
    dist[m]++;
  }
  var ok = 0;
  for (var a = 1; a <= 6; a++) {
    for (var b = 1; b <= 6; b++) {
      if (a + b < limit) ok += dist[a] * dist[b];
    }
  }
  return ok / (1296 * 1296);
}

var API = {
  crashProb: crashProb,
  axisSafeProb: axisSafeProb,
  axisLevelProb: axisLevelProb,
  axisCrashProb: axisCrashProb,
  bestAxisValue: bestAxisValue,
  axisMoveRisk: axisMoveRisk,
  controlScore: controlScore,
  travelSurvival: travelSurvival,
  bestStep: bestStep,
  stepRisk: stepRisk,
  progressRisk: progressRisk,
  roundOperations: roundOperations,
  sideScore: sideScore,
  sideParts: sideParts,
  distanceBehind: distanceBehind,
  axisParts: axisParts,
  progressParts: progressParts,
  scoreParts: scoreParts,
  partnerFaces: partnerFaces
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.SkyAIProb = API;
