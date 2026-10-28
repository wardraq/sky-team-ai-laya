/* 探针：把「一轮前瞻里的 rollout」换成真正的联合搜索，看有多少局面
 * 会因为贪心策略而选错第一步。
 *
 * 为什么可以联合搜索：这是纯合作游戏，机长和副驾目标一致，
 * 所以「本轮 8 颗骰子怎么分配」是一个联合优化问题，不需要 minimax。
 *
 * 对比：
 *   A（现状）= 枚举第一步 → quickMove 贪心走完本轮 → evaluate
 *   B（搜索）= 枚举第一步 → beam search 走完本轮 → evaluate
 * B 的搜索空间包含 A，所以 B 的分数必然 ≥ A；两者第一步不同即为「A 选错」。
 *
 * 用法：node test/ai/lookahead-search.js [决策点数] [beam宽度]
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner'));
var Eval = require(path.join(ROOT, 'ai/evaluate'));
var { GameLogic: Logic } = loadGameEnvironment(ROOT);

var LIMIT = parseInt(process.argv[2] || '60', 10);
var W = parseInt(process.argv[3] || '8', 10);

function clone(s) { return JSON.parse(JSON.stringify(s)); }

/** 本轮是否结束 */
function roundOver(s) {
  return s.phase !== 'place';
}

/** 把本轮走完：beam search（合作游戏，联合优化） */
function searchRound(s, Logic, cfg, width) {
  var frontier = [s];
  var guard = 0;

  while (!roundOver(frontier[0]) && guard++ < 12) {
    var next = [];
    for (var i = 0; i < frontier.length; i++) {
      var st = frontier[i];
      var role = st.currentPlayer;
      if (!role) break;
      var moves = Planner.enumerateMoves(st, role, Logic, {});
      for (var j = 0; j < moves.length; j++) {
        var t = clone(st);
        var m = moves[j];
        var r = Logic.placeDie(t, role, m.dieIdx, m.slot,
          { coffeePlus: m.cp, coffeeMinus: m.cm });
        if (!r || !r.ok) continue;
        next.push(t);
      }
    }
    if (!next.length) break;
    // 去重（同一局面只留一份）
    var seen = {}, uniq = [];
    for (var k = 0; k < next.length; k++) {
      var key = JSON.stringify([next[k].distance, next[k].axis, next[k].traffic,
        next[k].placements, next[k].coffee, next[k].currentPlayer]);
      if (seen[key]) continue;
      seen[key] = 1;
      uniq.push(next[k]);
    }
    uniq.sort(function (a, b) {
      return Eval.evaluate(b, Logic, cfg) - Eval.evaluate(a, Logic, cfg);
    });
    frontier = uniq.slice(0, width);
    if (frontier[0].phase === 'reveal') break;
  }

  // 结算，取最好的一条
  var best = null, bestV = -Infinity;
  for (var q = 0; q < frontier.length; q++) {
    var f = frontier[q];
    if (f.phase === 'reveal') Logic.resolveRound(f);
    var v = Eval.evaluate(f, Logic, cfg);
    if (v > bestV) { bestV = v; best = f; }
  }
  return { state: best, score: bestV };
}

/** 给定第一步，用贪心（现状）走完本轮 */
function greedyRound(s0, Logic, cfg, role, move, opts) {
  var t = clone(s0);
  var r = Logic.placeDie(t, role, move.dieIdx, move.slot,
    { coffeePlus: move.cp, coffeeMinus: move.cm });
  if (!r || !r.ok) return null;
  Planner.rollout(t, Logic, cfg, { aiRole: role, coop: opts.coop });
  return Eval.evaluate(t, Logic, cfg);
}

/** 给定第一步，用搜索走完本轮 */
function searchRoundFrom(s0, Logic, cfg, role, move, width) {
  var t = clone(s0);
  var r = Logic.placeDie(t, role, move.dieIdx, move.slot,
    { coffeePlus: move.cp, coffeeMinus: move.cm });
  if (!r || !r.ok) return null;
  if (roundOver(t)) {
    if (t.phase === 'reveal') Logic.resolveRound(t);
    return Eval.evaluate(t, Logic, cfg);
  }
  return searchRound(t, Logic, cfg, width).score;
}

function sameMove(a, b) {
  return a && b && a.dieIdx === b.dieIdx && a.slot === b.slot && a.val === b.val;
}

/* ---------- 主循环 ---------- */
var total = 0, diff = 0, improve = 0, bigGap = 0, bWorse = 0;
var examples = [];

for (var g = 0; g < 500 && total < LIMIT; g++) {
  var s = Logic.newGame();
  Logic.beginRound(s);
  var step = 0;

  while (s.phase !== 'win' && s.phase !== 'lose' && step++ < 600) {
    if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
    if (s.phase === 'roll') {
      Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
      s.phase = 'place'; s.currentPlayer = s.startPlayer; continue;
    }
    if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
    if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }

    var role = s.currentPlayer;
    var cfg = Logic.getScenarioConfig(s);
    var opts = { fair: false, coop: 1 };

    // 只在「本轮还没放几颗、且开局后」的点上比，避免每局上百次搜索
    var placedCount = 0;
    ['pilot', 'copilot'].forEach(function (rr) {
      Object.keys(s.placements[rr]).forEach(function (k) {
        if (s.placements[rr][k] !== null) placedCount++;
      });
    });
    if (placedCount > 2 && total >= LIMIT * 0.6) { /* 继续跑，但减少采样 */ }

    var ranked = Planner.rankMoves(s, role, Logic, cfg, opts);
    if (ranked.length >= 2) {
      total++;

      // 只比前 8 个候选：A/B 的最优第一步几乎不会落在更后面，
      // 全枚举会让 beam search 跑上百次。
      var cand = ranked.slice(0, 8);

      // A：现状 —— 每个候选都用贪心 rollout 评分
      var aBest = null, aV = -Infinity;
      for (var i = 0; i < cand.length; i++) {
        var vA = greedyRound(s, Logic, cfg, role, cand[i].move, opts);
        if (vA != null && vA > aV) { aV = vA; aBest = cand[i].move; }
      }

      // B：真搜索 —— 每个候选都用 beam search 走完本轮
      var bBest = null, bV = -Infinity;
      for (var j = 0; j < cand.length; j++) {
        var vB = searchRoundFrom(s, Logic, cfg, role, cand[j].move, W);
        if (vB != null && vB > bV) { bV = vB; bBest = cand[j].move; }
      }

      if (aBest && bBest) {
        // 自检：B 的搜索空间包含 A，所以 bV 不该低于 aV；低了就是剪枝出了问题
        if (bV < aV - 1e-6) bWorse++;
        if (!sameMove(aBest, bBest)) {
          diff++;
          var gap = bV - aV;
          if (gap > 0) improve++;
          if (Math.abs(gap) > 800) bigGap++;
          if (examples.length < 5 && Math.abs(gap) > 300) {
            examples.push({
              round: s.round, role: role, distance: s.distance,
              traffic: s.traffic.slice(), axis: s.axis,
              hand: s.dice[role].filter(function (d) { return !d.used && d.v > 0; })
                .map(function (d) { return d.v; }),
              a: aBest, b: bBest, aV: Math.round(aV), bV: Math.round(bV)
            });
          }
        }
      }
    }

    var mv = Planner.searchBestMove(s, role, Logic, cfg, opts);
    if (!mv) break;
    var rr2 = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    if (!rr2 || !rr2.ok) break;
  }
}

console.log('\n' + '='.repeat(70));
console.log('决策点 ' + total + ' 个（beam 宽度 ' + W + '）');
console.log('  自检：搜索分低于贪心分的次数 ' + bWorse + '（应为 0，否则剪枝有问题）');
console.log('  贪心 vs 搜索 第一步不同：' + diff + '  (' + (diff / total * 100).toFixed(1) + '%)');
console.log('  其中搜索更优：' + improve + '  (' + (improve / total * 100).toFixed(1) + '%)');
console.log('  差距 > 800 分：' + bigGap);
console.log('='.repeat(70));

examples.forEach(function (e, i) {
  console.log('\n【例 ' + (i + 1) + '】第' + e.round + '轮 ' + (e.role === 'pilot' ? '机长' : '副驾') +
    '  距 ' + e.distance + ' 格  跑道[' + e.traffic.join(',') + ']  手牌[' + e.hand.join(',') + ']');
  console.log('  贪心选：' + e.a.slot + ' = ' + e.a.val + '   分 ' + e.aV);
  console.log('  搜索选：' + e.b.slot + ' = ' + e.b.val + '   分 ' + e.bV +
    '   （差 ' + (e.bV - e.aV) + '）');
});
