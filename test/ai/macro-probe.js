/* ============================================================
 * 宏观要事 vs 原来的全局最高分。同一批种子各下一遍。
 *
 *   node test/ai/macro-probe.js [局数]
 * ============================================================ */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var N = parseInt(process.argv[2] || '40', 10);
var POPT = { fair: false, coop: 1, samples: 1, seed: 0 };

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

function play(seed, macro) {
  return withSeed(seed, function () {
    var s = Logic.newGame();
    Logic.beginRound(s);
    var guard = 0;
    var opts = {
      fair: POPT.fair, coop: POPT.coop, samples: POPT.samples, seed: POPT.seed,
      macro: macro
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
      if (!mv) return { stuck: true, phase: s.phase };
      var res = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
      if (!res || !res.ok) return { stuck: true, phase: s.phase };
    }
    return {
      win: s.phase === 'win',
      stuck: s.phase !== 'win' && s.phase !== 'lose',
      reason: s.loseReason || '',
      round: s.round
    };
  });
}

function shortReason(reason) {
  return (reason || '未知').split('：')[0].split('（')[0];
}

var baseWins = 0, macroWins = 0, both = 0, onlyBase = 0, onlyMacro = 0, stuck = 0;
var reasons = {};
var t0 = Date.now();

for (var i = 0; i < N; i++) {
  var seed = 10007 * (i + 1) + 17;
  var a = play(seed, false);
  Planner.resetMacroStats();
  var b = play(seed, true);
  var st = Planner.macroStats;
  if (a.stuck || b.stuck) stuck++;
  if (a.win) baseWins++;
  if (b.win) macroWins++;
  if (a.win && b.win) both++;
  else if (a.win && !b.win) onlyBase++;
  else if (!a.win && b.win) onlyMacro++;
  if (!b.win && !b.stuck) {
    var key = shortReason(b.reason);
    reasons[key] = (reasons[key] || 0) + 1;
  }
  var sec = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    '局 ' + (i + 1) + '/' + N +
    '  基线' + (a.win ? '胜' : '负') +
    '  宏观' + (b.win ? '胜' : '负') +
    '  分叉 ' + st.forked +
    '  改棋 ' + st.switched +
    '  领先不够 ' + st.kept +
    '  ' + sec + 's'
  );
}

console.log('\n' + N + ' 局配对');
console.log('  基线胜 ' + baseWins + ' (' + (baseWins / N * 100).toFixed(1) + '%)');
console.log('  宏观胜 ' + macroWins + ' (' + (macroWins / N * 100).toFixed(1) + '%)');
console.log('  都胜 ' + both + '  只基线胜 ' + onlyBase + '  只宏观胜 ' + onlyMacro + '  卡死 ' + stuck);
var keys = Object.keys(reasons).sort(function (x, y) { return reasons[y] - reasons[x]; });
keys.slice(0, 6).forEach(function (k) {
  console.log('  宏观负因  ' + reasons[k] + '  ' + k);
});
console.log('  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
