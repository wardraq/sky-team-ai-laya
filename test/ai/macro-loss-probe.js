/* ============================================================
 * 宏观版的负局里，分数差超过门槛、终局没比过的手，补比一次。
 * 看这些手里有多少其实该换，有多少是怎么下都输。
 *
 *   node test/ai/macro-loss-probe.js [局数]
 * ============================================================ */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var N = parseInt(process.argv[2] || '80', 10);
var POPT = { fair: false, coop: 1, samples: 1, seed: 0, macro: true, macroSamples: 8, macroMargin: 2 };

Planner.setRng(function () { return 0.5; });

function withSeed(seed, fn) {
  var prev = Math.random;
  var s = (seed >>> 0) || 1;
  Math.random = function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  try { return fn(); }
  finally { Math.random = prev; }
}

function armBrief(a) {
  return {
    id: a.id,
    score: Math.round(a.score),
    slot: a.move.slot,
    val: a.move.val,
    dieIdx: a.move.dieIdx,
    cp: a.move.cp || 0,
    cm: a.move.cm || 0
  };
}

function play(seed) {
  return withSeed(seed, function () {
    var s = Logic.newGame();
    Logic.beginRound(s);
    var guard = 0;
    var wides = [];
    var opts = {
      fair: POPT.fair, coop: POPT.coop, samples: POPT.samples, seed: POPT.seed,
      macro: true,
      onWide: function (st, role, all) {
        wides.push({
          state: JSON.parse(JSON.stringify(st)),
          role: role,
          arms: all.map(armBrief),
          gap: Math.round(all[0].score - all[1].score)
        });
      }
    };
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
      var role = s.currentPlayer;
      var cfg = Logic.getScenarioConfig(s);
      var mv = Planner.searchBestMove(s, role, Logic, cfg, opts);
      if (!mv) return { stuck: true, wides: wides };
      var res = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
      if (!res || !res.ok) return { stuck: true, wides: wides };
    }
    return { win: s.phase === 'win', stuck: s.phase !== 'win' && s.phase !== 'lose', reason: s.loseReason || '', wides: wides };
  });
}

function shortReason(reason) {
  return (reason || '未知').split('：')[0].split('（')[0].split('！')[0];
}

function replayArm(snap, brief) {
  return {
    id: brief.id,
    score: brief.score,
    move: { dieIdx: brief.dieIdx, slot: brief.slot, val: brief.val, cp: brief.cp, cm: brief.cm }
  };
}

var losses = 0, wins = 0, stuck = 0;
var withSwitch = 0, switchPoints = 0, doomedPoints = 0, widePoints = 0;
var byReason = {};
var underrated = {};
var examples = [];
var t0 = Date.now();

for (var i = 0; i < N; i++) {
  var seed = 10007 * (i + 1) + 17;
  var game = play(seed);
  if (game.stuck) { stuck++; continue; }
  if (game.win) {
    wins++;
    if ((i + 1) % 10 === 0) {
      console.log('进度 ' + (i + 1) + '/' + N + '  胜 ' + wins + '  负 ' + losses + '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
    }
    continue;
  }
  losses++;
  var reason = shortReason(game.reason);
  var switchedHere = 0;
  var doomedHere = 0;
  widePoints += game.wides.length;
  for (var w = 0; w < game.wides.length; w++) {
    var snap = game.wides[w];
    var arms = snap.arms.map(function (b) { return replayArm(snap, b); });
    var fork = withSeed(seed + 17, function () {
      return Planner.forkWins(snap.state, snap.role, Logic, POPT, arms);
    });
    var bestI = 0, second = -1;
    for (var u = 1; u < fork.wins.length; u++) if (fork.wins[u] > fork.wins[bestI]) bestI = u;
    for (var v = 0; v < fork.wins.length; v++) if (v !== bestI && fork.wins[v] > second) second = fork.wins[v];
    var lead = fork.wins[bestI] - (second < 0 ? 0 : second);
    var bestWins = fork.wins[bestI];
    if (bestWins === 0) doomedHere++;
    if (fork.n >= fork.M && lead >= 2 && bestI !== 0) {
      switchedHere++;
      switchPoints++;
      var id = arms[bestI].id;
      underrated[id] = (underrated[id] || 0) + 1;
      if (examples.length < 8) {
        examples.push({
          game: i + 1,
          round: snap.state.round,
          role: snap.role,
          landing: !!snap.state.landingRound,
          waiting: !!snap.state.waiting,
          axis: snap.state.axis,
          distance: snap.state.distance,
          gap: snap.gap,
          from: arms[0].id + ':' + arms[0].slot + '=' + arms[0].move.val,
          to: arms[bestI].id + ':' + arms[bestI].slot + '=' + arms[bestI].move.val,
          wins: fork.wins.join('/')
        });
      }
    }
  }
  doomedPoints += doomedHere;
  if (switchedHere > 0) withSwitch++;
  if (!byReason[reason]) byReason[reason] = { n: 0, fixable: 0 };
  byReason[reason].n++;
  if (switchedHere > 0) byReason[reason].fixable++;
  var sec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    '负局 ' + (i + 1) +
    '  ' + reason +
    '  过宽 ' + game.wides.length +
    '  该换 ' + switchedHere +
    '  全输点 ' + doomedHere +
    '  ' + sec + 's'
  );
}

console.log('\n' + N + ' 局  胜 ' + wins + '  负 ' + losses + '  卡死 ' + stuck);
console.log('负局里分数过宽、没打终局的决策点 ' + widePoints);
console.log('其中终局会改棋的点 ' + switchPoints + '  涉及负局 ' + withSwitch);
console.log('其中代表手全输的点 ' + doomedPoints);
console.log('被低估的要事：');
Object.keys(underrated).sort(function (a, b) { return underrated[b] - underrated[a]; }).forEach(function (k) {
  console.log('  ' + underrated[k] + '  ' + k);
});
console.log('按负因：');
Object.keys(byReason).sort(function (a, b) { return byReason[b].n - byReason[a].n; }).forEach(function (k) {
  console.log('  ' + byReason[k].n + ' 局，其中 ' + byReason[k].fixable + ' 局有过宽改棋  ' + k);
});
examples.forEach(function (e) {
  console.log(
    '例 局' + e.game + ' 第' + e.round + '轮 ' + e.role +
    (e.landing ? ' 着陆' : '') + (e.waiting ? ' 等待' : '') +
    ' 姿态' + e.axis + ' 距' + e.distance +
    ' 分差' + e.gap +
    '  ' + e.from + ' → ' + e.to +
    '  胜' + e.wins
  );
});
console.log('用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
