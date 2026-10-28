/* ============================================================
 * 给 Laya 微调采标签。
 *
 * 标签不是规划器选了哪件要事，而是：同一局面、同一批骰子，
 * 每件真题要事各走一条路到终局，哪条路赢得多，就把那件标成答案。
 * 领先不够的丢掉，避免把噪声写进训练集。
 *
 * 用法：
 *   node test/ai/laya-finetune-data.js [保留条数] [每臂局数] [最少净胜局] [输出目录]
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var Prompt = require(path.join(ROOT, 'ai/laya-prompt.js'));
var Laya = require(path.join(ROOT, 'ai/laya-client.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var TARGET = parseInt(process.argv[2] || '180', 10);
var M = parseInt(process.argv[3] || '16', 10);
var MARGIN = parseInt(process.argv[4] || '4', 10);
var OUT = process.argv[5] || path.join(ROOT, 'data/laya-finetune');
var POPT = { fair: false, coop: 1, seed: 0, samples: 1 };
var MAX_GAMES = 4000;

var _origRandom = Math.random;
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
Planner.setRng(function () { return 0.5; });

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

function moveKey(m) {
  return m.dieIdx + '/' + m.slot + '/' + m.val + '/' + (m.cp || 0) + '/' + (m.cm || 0);
}

function forkArms(base, role, arms, seedBase) {
  var wins = arms.map(function () { return 0; });
  var n = 0;
  for (var k = 0; k < M; k++) {
    var seed = seedBase + k * 7919;
    var ok = true;
    var results = [];
    for (var a = 0; a < arms.length; a++) {
      var hit = withSeed(seed, function () {
        var t = JSON.parse(JSON.stringify(base));
        if (!applyMove(t, role, arms[a].move)) return null;
        return playOut(t);
      });
      if (hit === null) { ok = false; break; }
      results.push(hit);
    }
    if (!ok) continue;
    n++;
    for (var i = 0; i < results.length; i++) if (results[i]) wins[i]++;
  }
  return { wins: wins, n: n };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  var trainPath = path.join(OUT, 'train.jsonl');
  var evalPath = path.join(OUT, 'eval.jsonl');
  var trainFd = fs.openSync(trainPath, 'w');
  var evalFd = fs.openSync(evalPath, 'w');

  var kept = 0, seen = 0, games = 0, skippedTie = 0, skippedDup = 0, agree = 0;
  var seenText = {};
  var t0 = Date.now();

  while (kept < TARGET && games < MAX_GAMES) {
    games++;
    var gameSeed = 10007 * games + 17;
    var holdout = (games % 5) === 0;
    var cont = withSeed(gameSeed, function () {
      var s = Logic.newGame();
      Logic.beginRound(s);
      var guard = 0;
      while (s.phase !== 'win' && s.phase !== 'lose' && guard++ < 400 && kept < TARGET) {
        if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
        if (s.phase === 'roll') {
          Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
          s.phase = 'place'; s.currentPlayer = s.startPlayer; continue;
        }
        if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
        if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }
        if (s.phase !== 'place') break;

        var role = s.currentPlayer;
        var cfg = Logic.getScenarioConfig(s);
        var ranked = Planner.rankMoves(s, role, Logic, cfg, POPT);
        if (!ranked.length) break;
        var active = Planner.activePriorities(ranked);
        var usable = Laya.usablePriorities(ranked, active);
        var plannerMove = Planner.bestMove(ranked, null, POPT);

        if (usable.length >= 2 && plannerMove) {
          var arms = [];
          var usedMove = {};
          for (var i = 0; i < usable.length; i++) {
            var mv = Planner.bestMove(ranked, usable[i], POPT);
            if (!mv) continue;
            var key = moveKey(mv);
            if (usedMove[key]) continue;
            usedMove[key] = 1;
            arms.push({ id: usable[i], move: mv });
          }
          if (arms.length >= 2) {
            seen++;
            var options = Prompt.renderPriorities(s, role, Logic, cfg, arms.map(function (a) { return a.id; }));
            var stateText = Prompt.describeState(s, role, Logic);
            var sig = stateText + '\n' + options.map(function (o) { return o.text; }).join('|');
            if (seenText[sig]) {
              skippedDup++;
            } else {
              seenText[sig] = 1;
              var base = JSON.parse(JSON.stringify(s));
              var fork = forkArms(base, role, arms, 900000 + seen * 104729);
              var bestI = 0, second = -1;
              for (var w = 0; w < fork.wins.length; w++) {
                if (fork.wins[w] > fork.wins[bestI]) bestI = w;
              }
              for (var u = 0; u < fork.wins.length; u++) {
                if (u !== bestI && fork.wins[u] > second) second = fork.wins[u];
              }
              var lead = fork.wins[bestI] - (second < 0 ? 0 : second);
              if (fork.n < M || lead < MARGIN) {
                skippedTie++;
              } else {
                var criteria = {};
                options.forEach(function (o) { criteria[o.key] = o.text; });
                var row = {
                  state: stateText,
                  questions: {
                    move: {
                      type: 'choice',
                      instructions: Prompt.instructionsFor(role, cfg.ROUNDS),
                      criteria: criteria
                    }
                  },
                  expected: { move: options[bestI].key },
                  wins: fork.wins,
                  n: fork.n,
                  priorities: arms.map(function (a) { return a.id; }),
                  winner: arms[bestI].id,
                  plannerSame: moveKey(arms[bestI].move) === moveKey(plannerMove)
                };
                if (row.plannerSame) agree++;
                var line = JSON.stringify(row) + '\n';
                fs.writeSync(holdout ? evalFd : trainFd, line);
                kept++;
                var sec = (Date.now() - t0) / 1000;
                console.log(
                  (holdout ? 'eval ' : 'train') +
                  ' #' + kept +
                  '  ' + arms[bestI].id +
                  '  胜 ' + fork.wins.join('/') +
                  '  领先 ' + lead +
                  '  与规划器' + (row.plannerSame ? '相同' : '不同') +
                  '  ' + sec.toFixed(0) + 's'
                );
              }
            }
          }
        }

        if (!plannerMove || !applyMove(s, role, plannerMove)) break;
      }
      return true;
    });
    if (!cont) break;
  }

  fs.closeSync(trainFd);
  fs.closeSync(evalFd);
  var stats = {
    kept: kept,
    seen: seen,
    games: games,
    skippedTie: skippedTie,
    skippedDup: skippedDup,
    plannerSame: agree,
    M: M,
    margin: MARGIN,
    seconds: Math.round((Date.now() - t0) / 1000)
  };
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats));
}

main();
