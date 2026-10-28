/* 看一个宏观负局里，评分选中的引擎/姿态，旁边还有没有更小的点数。
 *   node test/ai/macro-trace-loss.js [第几局，从 1 计]
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var N = parseInt(process.argv[2] || '4', 10);
var seed = 10007 * N + 17;
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

withSeed(seed, function () {
  var s = Logic.newGame();
  Logic.beginRound(s);
  var guard = 0;
  var opts = { fair: false, coop: 1, samples: 1, seed: 0, macro: true };
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
    var ranked = Planner.rankMoves(s, role, Logic, cfg, opts);
    var mv = Planner.searchBestMove(s, role, Logic, cfg, opts);
    if (!mv) break;
    var interesting = mv.slot === 'engine' || mv.slot === 'axis' || s.landingRound || s.waiting || s.distance === 0;
    if (interesting) {
      var alts = ranked.filter(function (r) { return r.move.slot === mv.slot; });
      var seen = {};
      var brief = [];
      alts.forEach(function (r) {
        if (seen[r.move.val]) return;
        seen[r.move.val] = 1;
        brief.push(r.move.val + '(' + Math.round(r.score) + ')');
      });
      var hand = s.dice[role].filter(function (d) { return !d.used && d.v > 0; }).map(function (d) { return d.v; });
      var oppE = s.placements[role === 'pilot' ? 'copilot' : 'pilot'].engine;
      console.log(
        'R' + s.round + ' ' + role +
        (s.landingRound ? ' 着陆' : '') + (s.distance === 0 ? ' 距0' : ' 距' + s.distance) +
        ' 姿态' + s.axis +
        ' 手' + hand.join(',') +
        ' 对手引擎' + (oppE ? Logic.effVal(oppE) : '-') +
        ' → ' + mv.slot + '=' + mv.val +
        '  同槽 ' + brief.join(' ')
      );
    }
    var res = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    if (!res || !res.ok) break;
  }
  console.log('终局 ' + s.phase + '  ' + (s.loseReason || ''));
});
