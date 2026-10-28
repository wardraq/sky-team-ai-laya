/* 宏观版 vs 宏观版+坠毁概率。同一批种子。
 *   node test/ai/prob-probe.js [局数]
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var N = parseInt(process.argv[2] || '40', 10);
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
  try { return fn(); } finally { Math.random = prev; }
}

function play(seed, prob) {
  return withSeed(seed, function () {
    var s = Logic.newGame();
    Logic.beginRound(s);
    var guard = 0;
    var opts = { fair: false, coop: 1, samples: 1, seed: 0, macro: true, prob: prob };
    while (s.phase !== 'win' && s.phase !== 'lose' && guard++ < 400) {
      if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
      if (s.phase === 'roll') {
        Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
        s.phase = 'place'; s.currentPlayer = s.startPlayer; continue;
      }
      if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
      if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }
      var role = s.currentPlayer;
      var cfg = Logic.getScenarioConfig(s);
      var mv = Planner.searchBestMove(s, role, Logic, cfg, opts);
      if (!mv) return { stuck: true, phase: s.phase };
      var res = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
      if (!res || !res.ok) return { stuck: true, phase: s.phase, why: res && res.why };
    }
    return { win: s.phase === 'win', stuck: s.phase !== 'win' && s.phase !== 'lose', reason: s.loseReason || '' };
  });
}

function shortReason(reason) {
  return (reason || '未知').split('：')[0].split('（')[0].split('！')[0];
}

var oldW = 0, newW = 0, both = 0, onlyOld = 0, onlyNew = 0, stuck = 0;
var reasons = {};
var t0 = Date.now();
for (var i = 0; i < N; i++) {
  var seed = 10007 * (i + 1) + 17;
  var a = play(seed, false);
  var b = play(seed, true);
  if (a.stuck || b.stuck) {
    stuck++;
    console.log('卡死', i + 1, a.phase, a.why, b.phase, b.why);
  }
  if (a.win) oldW++;
  if (b.win) newW++;
  if (a.win && b.win) both++;
  else if (a.win && !b.win) onlyOld++;
  else if (!a.win && b.win) onlyNew++;
  if (!b.win && !b.stuck) {
    var key = shortReason(b.reason);
    reasons[key] = (reasons[key] || 0) + 1;
  }
  console.log(
    '局 ' + (i + 1) + '/' + N +
    '  宏观' + (a.win ? '胜' : '负') +
    '  概率' + (b.win ? '胜' : '负') +
    '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's'
  );
}
console.log('\n' + N + ' 局');
console.log('  宏观胜 ' + oldW + ' (' + (oldW / N * 100).toFixed(1) + '%)');
console.log('  概率胜 ' + newW + ' (' + (newW / N * 100).toFixed(1) + '%)');
console.log('  都胜 ' + both + '  只宏观胜 ' + onlyOld + '  只概率胜 ' + onlyNew + '  卡死 ' + stuck);
Object.keys(reasons).sort(function (x, y) { return reasons[y] - reasons[x]; }).forEach(function (k) {
  console.log('  概率负因  ' + reasons[k] + '  ' + k);
});
console.log('  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
