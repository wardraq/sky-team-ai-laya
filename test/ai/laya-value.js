/* ============================================================
 * 决策点分叉实验 —— Laya 的选择到底好不好的唯一可靠判据
 *
 * 为什么不能用「准确率」：
 *   这个游戏没有 ground truth 标签。「该先清障还是先配平」没有人知道标准答案，
 *   唯一的真值是游戏结果（胜/负）。但整局胜率太钝 —— Laya 只在约 17% 的决策点
 *   被问到，其中约 2.4% 会改变落子，整局胜率的信噪比低到要跑上万局才能分辨。
 *
 * 所以把测量下沉到决策点：
 *   固定一个局面 → 岔开两条路（A：参照选择；B：候选选择）→ 各自跑到终局 → 比胜率。
 *   两条路用同一批骰子（common random numbers），把骰子方差抵消掉。
 *   这样每个决策点给出一个 Δ，几十局就有信号，聚合起来就是「这个选择值多少胜率」。
 *
 * 三道保险：
 *   1) 配对骰子 —— 同一 seed 跑两边，消除运气成分
 *   2) 对照组   —— greedy / worst 两个已知很差的臂。尺子如果量不出它们差，
 *                  就没资格去量 Laya
 *   3) 只看决策点 —— 不掺整局的噪声
 *
 * 用法：
 *   node test/ai/laya-value.js [决策点数] [每臂局数]
 *   Laya 臂需要 ai/laya_service.py 在 7788 上跑着；不在就自动跳过该臂。
 * ============================================================ */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var Laya = require(path.join(ROOT, 'ai/laya-client.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var N_POINTS = parseInt(process.argv[2] || '60', 10);
var M_GAMES = parseInt(process.argv[3] || '80', 10);

/* 与线上 AI 同一套设置（fair=false 对应默认的全知视角） */
var POPT = { fair: false, coop: 1, seed: 0, samples: 1 };

/* ---------- 可复现的骰子流 ----------
 * 游戏的每一个骰子都走 game-logic 里的 d6() → Math.random()。
 * 把它换成可播种的流，两边就能拿到同一批骰子。
 * 规划器内部的策略噪声（对手建模 / 同分兜底）已通过 setRng 摘出去，
 * 不再消耗这条流 —— 所以配对是干净的。 */
var _origRandom = Math.random;
function withSeed(seed, fn) {
  var s = (seed >>> 0) || 1;
  Math.random = function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  try { return fn(); } finally { Math.random = _origRandom; }
}
Planner.setRng(function () { return 0.5; });

/* 收集期用的独立随机（不碰骰子流） */
var _pick = 12345;
function pickRandom(n) {
  _pick = (_pick * 1103515245 + 12345) & 0x7fffffff;
  return _pick % n;
}

/* ---------- 用规划器把一局走完，返回是否胜 ---------- */
function playOut(s) {
  var g = 0;
  while (s.phase !== 'win' && s.phase !== 'lose' && g++ < 400) {
    if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
    if (s.phase === 'roll') {
      Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
      s.phase = 'place'; s.currentPlayer = s.startPlayer; continue;
    }
    if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
    if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }
    var r = s.currentPlayer;
    var cfg = Logic.getScenarioConfig(s);
    var m = Planner.searchBestMove(s, r, Logic, cfg, POPT);
    if (!m) break;
    var res = Logic.placeDie(s, r, m.dieIdx, m.slot, { coffeePlus: m.cp, coffeeMinus: m.cm });
    if (!res || !res.ok) break;
  }
  return s.phase === 'win';
}

function applyMove(s, role, m) {
  var r = Logic.placeDie(s, role, m.dieIdx, m.slot, { coffeePlus: m.cp || 0, coffeeMinus: m.cm || 0 });
  return !!(r && r.ok);
}

/* ---------- 分叉：同一局面、同一骰子，两条路各跑到终局 ---------- */
function fork(base, role, refMove, candMove, M, seedBase) {
  var rw = 0, cw = 0, bad = 0;
  for (var k = 0; k < M; k++) {
    var seed = seedBase + k * 7919;
    var a = withSeed(seed, function () {
      var t = JSON.parse(JSON.stringify(base));
      if (!applyMove(t, role, refMove)) return null;
      return playOut(t);
    });
    var b = withSeed(seed, function () {
      var t = JSON.parse(JSON.stringify(base));
      if (!applyMove(t, role, candMove)) return null;
      return playOut(t);
    });
    if (a === null || b === null) { bad++; continue; }
    if (a) rw++;
    if (b) cw++;
  }
  return { rw: rw, cw: cw, n: M - bad };
}

/* ============================================================
 * 第一阶段：采样决策点 + 收集各臂的选择
 * ============================================================ */
function sameMove(a, b) {
  return a && b && a.dieIdx === b.dieIdx && a.slot === b.slot && a.val === b.val;
}

/* 要事是「语义标签」，不是「动作集合」。
 * match_axis 和 fill_mandatory 可以指向同一批落子 —— 那时给 Laya 是道假题。
 * 这里量出每个要事背后真实有多少落子，以及有几个是不同的集合。 */
function prioritySets(ranked, active) {
  var map = {}, sizes = {}, sigs = {};
  var i, j, k;
  for (i = 0; i < active.length; i++) map[active[i]] = {};
  for (j = 0; j < ranked.length; j++) {
    var ps = ranked[j].priorities || [];
    for (k = 0; k < ps.length; k++) {
      if (map[ps[k]]) map[ps[k]][j] = 1;
    }
  }
  for (i = 0; i < active.length; i++) {
    var keys = Object.keys(map[active[i]]);
    sizes[active[i]] = keys.length;
    sigs[keys.sort().join(',')] = 1;
  }
  return { sizes: sizes, distinct: Object.keys(sigs).length };
}

/* 候选落子的唯一键，用来判断两个选择是不是同一个动作 */
function moveKey(m) {
  return m ? m.dieIdx + '/' + m.slot + '/' + m.val : 'null';
}

function collect(target) {
  var points = [];
  var visited = 0;

  return (function nextGame() {
    if (points.length >= target) return Promise.resolve(points);
    var s = Logic.newGame();
    Logic.beginRound(s);
    var g = 0;

    return (function step() {
      if (points.length >= target || g++ > 400) {
        if (s.phase === 'win' || s.phase === 'lose' || g > 400) return nextGame();
      }
      if (s.phase === 'discuss') { s.phase = 'roll'; return step(); }
      if (s.phase === 'roll') {
        Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
        s.phase = 'place'; s.currentPlayer = s.startPlayer; return step();
      }
      if (s.phase === 'reveal') { Logic.resolveRound(s); return step(); }
      if (s.phase === 'roundEnd') { Logic.nextRound(s); return step(); }
      if (s.phase !== 'place') return nextGame();

      var role = s.currentPlayer;
      var cfg = Logic.getScenarioConfig(s);
      var ranked = Planner.rankMoves(s, role, Logic, cfg, POPT);
      if (!ranked.length) return nextGame();
      var active = Planner.activePriorities(ranked);

      // 只在「Laya 会被问到」的局面上取证：成立的要事 ≥ 2 件
      if (active.length >= 2) {
        var best = Planner.bestMove(ranked, null, POPT);
        var refMove = best;
        var greedy = Planner.quickMove(s, role, Logic, cfg, { asOpponent: false, coop: 1 });
        var snap = {
          round: s.round,
          role: role,
          landing: !!s.landingRound,
          legality: ranked.length,
          active: active.slice(),
        sets: prioritySets(ranked, active).sizes,
        distinctSets: prioritySets(ranked, active).distinct,
        usableCount: Laya.usablePriorities(ranked, active).length,
          base: JSON.parse(JSON.stringify(s)),
          ref: refMove,
          greedy: greedy,
          random: ranked[pickRandom(ranked.length)].move,
          worst: ranked[ranked.length - 1].move,
          laya: null,
          layaPriority: null,
          ownPriority: Planner.ownPriority(ranked, refMove),
          confidence: null
        };
        points.push(snap);
        visited++;
      }

      var mv = Planner.searchBestMove(s, role, Logic, cfg, POPT);
      if (!mv || !applyMove(s, role, mv)) return nextGame();
      return step();
    })();
  })();
}

/* ============================================================
 * 主流程
 * ============================================================ */
function main() {
  var health = { ok: false };
  return Laya.health().then(function (h) {
    health = h;
    console.log('laya 服务: ' + (h && h.ok ? '✓ 就绪  model=' + (h.model || '-') : '△ 未就绪（跳过 laya 臂）'));
  }).then(function () {
    if (!health.ok) return null;
    return collect2(N_POINTS);
  }).then(function (points) {
    if (!points) return collect(N_POINTS);
    return points;
  }).then(function (points) {
    return runReport(points, health.ok);
  }).catch(function (e) {
    console.error('实验失败:', e && e.stack || e);
    process.exit(1);
  });
}

/* 带 laya 调用的采样（顺序 await，避免并发打爆服务） */
function collect2(target) {
  var points = [];
  return (function nextGame() {
    if (points.length >= target) return Promise.resolve(points);
    var s = Logic.newGame();
    Logic.beginRound(s);
    var g = 0;

    return (function step() {
      if (points.length >= target || g++ > 400) return nextGame();
      if (s.phase === 'discuss') { s.phase = 'roll'; return step(); }
      if (s.phase === 'roll') {
        Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
        s.phase = 'place'; s.currentPlayer = s.startPlayer; return step();
      }
      if (s.phase === 'reveal') { Logic.resolveRound(s); return step(); }
      if (s.phase === 'roundEnd') { Logic.nextRound(s); return step(); }
      if (s.phase !== 'place') return nextGame();

      var role = s.currentPlayer;
      var cfg = Logic.getScenarioConfig(s);
      var ranked = Planner.rankMoves(s, role, Logic, cfg, POPT);
      if (!ranked.length) return nextGame();
      var active = Planner.activePriorities(ranked);
      if (active.length < 2) {
        var mv0 = Planner.searchBestMove(s, role, Logic, cfg, POPT);
        if (!mv0 || !applyMove(s, role, mv0)) return nextGame();
        return step();
      }

      var best = Planner.bestMove(ranked, null, POPT);
      var refMove = best;
      var snap = {
        round: s.round,
        role: role,
        landing: !!s.landingRound,
        legality: ranked.length,
        active: active.slice(),
        sets: prioritySets(ranked, active).sizes,
        distinctSets: prioritySets(ranked, active).distinct,
        usableCount: Laya.usablePriorities(ranked, active).length,
        base: JSON.parse(JSON.stringify(s)),
        ref: refMove,
        greedy: Planner.quickMove(s, role, Logic, cfg, { asOpponent: false, coop: 1 }),
        random: ranked[pickRandom(ranked.length)].move,
        worst: ranked[ranked.length - 1].move,
        laya: null,
        layaPriority: null,
        ownPriority: Planner.ownPriority(ranked, refMove),
        confidence: null
      };
      points.push(snap);

      // 同步走规划器的正常路径，保证后续局面与真实对局一致
      var mv = Planner.searchBestMove(s, role, Logic, cfg, POPT);
      if (!mv || !applyMove(s, role, mv)) return nextGame();

      // 用「决策发生前」的快照去问 laya（同一局面）
      var askState = snap.base;
      return Laya.choosePriority(Logic, askState, role, { verbose: false }).then(function (info) {
        if (info && info.choice && info.ranked && info.ranked.length) {
          var picked = Planner.bestMove(info.ranked, info.choice, POPT);
          if (picked) {
            snap.laya = picked;
            snap.layaPriority = info.choice;
            snap.confidence = info.confidence;
          }
        }
        return step();
      });
    })();
  })();
}

function fmt(x) { return (x * 100).toFixed(1).padStart(5) + '%'; }

function runReport(points, hasLaya) {
  console.log('\n采样到 ' + points.length + ' 个「Laya 会被问到」的决策点，每个岔路口跑 ' + M_GAMES + ' 局');
  var roles = { pilot: 0, copilot: 0 };
  points.forEach(function (p) { roles[p.role]++; });
  console.log('  机长 ' + roles.pilot + ' / 副驾 ' + roles.copilot +
    '   着陆轮 ' + points.filter(function (p) { return p.landing; }).length +
    '   中位合法落子数 ' + points.map(function (p) { return p.legality; }).sort(function (a, b) { return a - b; })[Math.floor(points.length / 2)]);

  /* ---------- 问题质量：Laya 到底有没有被问到真问题 ---------- */
  var fake = 0, real = 0, asked = 0;
  var byRound = {};
  points.forEach(function (p) {
    byRound[p.round] = (byRound[p.round] || 0) + 1;
    var distinct = p.distinctSets != null ? p.distinctSets : p.active.length;
    var minSet = Math.min.apply(null, p.active.map(function (id) { return p.sets ? p.sets[id] : 1; }));
    if (distinct < p.active.length || minSet <= 1) fake++; else real++;
    if (p.layaPriority) asked++;
  });
  console.log('\n【问题质量】Laya 被问到的这些局面，有多少是真的选择题');
  console.log('  要事标签数 ≥2 但动作集合重复（假题）：' + fake + '/' + points.length +
    '  (' + (fake / points.length * 100).toFixed(0) + '%)');
  console.log('  真的有两套不同动作可选（真题）：      ' + real + '/' + points.length +
    '  (' + (real / points.length * 100).toFixed(0) + '%)');
  var gated = points.filter(function (p) { return p.usableCount >= 2; }).length;
  console.log('  加「可用性闸门」后仍会发问：          ' + gated + '/' + points.length +
    '  (' + (gated / points.length * 100).toFixed(0) + '%)  ← 其余交给规划器，不浪费一次前向');
  console.log('  轮次分布：' + Object.keys(byRound).sort(function (a, b) { return a - b; })
    .map(function (r) { return 'R' + r + ':' + byRound[r]; }).join('  '));

  var arms = [
    { key: 'greedy', label: '逐颗贪心', note: '对照组（已知很差）' },
    { key: 'worst', label: '规划器最差', note: '对照组（下界）' },
    { key: 'random', label: '随机合法', note: '对照组' }
  ];
  if (hasLaya) arms.push({ key: 'laya', label: 'Laya 的选择', note: '被测对象' });

  var t0 = Date.now();
  var rows = [];

  arms.forEach(function (arm) {
    var sumR = 0, sumC = 0, sumN = 0, win = 0, lose = 0, tie = 0, noop = 0, used = 0;
    points.forEach(function (p, i) {
      var cand = p[arm.key];
      if (!cand) return;
      used++;
      if (sameMove(cand, p.ref)) { noop++; return; }
      var f = fork(p.base, p.role, p.ref, cand, M_GAMES, 1000000 + i * 104729);
      sumR += f.rw; sumC += f.cw; sumN += f.n;
      if (f.cw > f.rw) win++; else if (f.cw < f.rw) lose++; else tie++;
    });
    var refRate = sumN ? sumR / sumN : 0;
    var candRate = sumN ? sumC / sumN : 0;
    rows.push({
      label: arm.label, note: arm.note, used: used, noop: noop,
      refRate: refRate, candRate: candRate, delta: candRate - refRate,
      win: win, lose: lose, tie: tie, games: sumN
    });
  });

  var ms = Date.now() - t0;
  console.log('\n' + '='.repeat(74));
  console.log('分叉实验（参照臂 = 规划器全局最优；同局面同骰子，配对比较）');
  console.log('='.repeat(74));
  console.log('  臂            决策点  同选   参照胜率  该臂胜率     Δ      更优 更差 持平');
  console.log('  ' + '-'.repeat(70));
  rows.forEach(function (r) {
    console.log('  ' + (r.label + '　       　').slice(0, 12) +
      String(r.used).padStart(5) + String(r.noop).padStart(6) +
      fmt(r.refRate).padStart(9) + fmt(r.candRate).padStart(10) +
      ((r.delta >= 0 ? '+' : '') + (r.delta * 100).toFixed(1) + 'pp').padStart(9) +
      String(r.win).padStart(6) + String(r.lose).padStart(5) + String(r.tie).padStart(5));
  });
  console.log('='.repeat(74));
  console.log('  共 ' + rows.reduce(function (a, r) { return a + r.games; }, 0) + ' 局，用时 ' + (ms / 1000).toFixed(1) + 's');

  // 尺子自检
  var ctrl = rows.filter(function (r) { return r.label !== 'Laya 的选择' && r.noop < r.used; });
  var worstCtrl = Math.min.apply(null, ctrl.map(function (r) { return r.delta; }));
  console.log('\n【尺子自检】');
  if (worstCtrl < -0.05) {
    console.log('  ✓ 对照组被量出了明显负收益（最低 ' + (worstCtrl * 100).toFixed(1) +
      'pp）—— 这把尺子能分辨好坏，结论可用');
  } else {
    console.log('  ✗ 对照组没被量出差别（最低 ' + (worstCtrl * 100).toFixed(1) +
      'pp）—— 尺子失效，任何 Laya 结论都不可信。多半是每臂局数太少');
  }

  if (hasLaya) {
    var L = rows.filter(function (r) { return r.label === 'Laya 的选择'; })[0];
    console.log('\n【结论】');
    if (!L || L.used === 0) {
      console.log('  Laya 一次都没被真正询问到，无法评价');
    } else {
      var pct = L.delta * 100;
      var verdict = Math.abs(pct) < 1.0
        ? '与规划器全局最优**统计上无法区分** —— 既没帮上也谈不上拖累'
        : (pct > 0 ? '平均略优于规划器最优（罕见，需复核）' : '平均**劣于**规划器最优');
      console.log('  被问到 ' + L.used + ' 次，其中 ' + L.noop + ' 次与规划器同选（无影响）');
      console.log('  剩下 ' + (L.used - L.noop) + ' 次的实际影响：' + (pct >= 0 ? '+' : '') + pct.toFixed(1) +
        'pp  →  ' + verdict);
      console.log('  逐点胜负：' + L.win + ' 次更优 / ' + L.lose + ' 次更差 / ' + L.tie + ' 次持平');
    }
  }

  // 落盘
  var outPath = path.join(__dirname, '.laya-value.json');
  require('fs').writeFileSync(outPath, JSON.stringify({
    when: new Date().toISOString(),
    points: points.length, gamesPerArm: M_GAMES,
    rows: rows,
    perPoint: points.map(function (p) {
      return {
        round: p.round, role: p.role, landing: p.landing, legality: p.legality,
        active: p.active, sets: p.sets, distinctSets: p.distinctSets,
        own: p.ownPriority, layaPriority: p.layaPriority,
        confidence: p.confidence, asked: !!p.laya,
        refMove: moveKey(p.ref), layaMove: moveKey(p.laya)
      };
    })
  }, null, 2));
  console.log('\n明细已写出 ' + outPath);
}

main();
