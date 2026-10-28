/* 探针：同一轮内「先推进 → 再清障」这个顺序耦合，
 * planner 有没有评估到？
 *
 * 规则（game-logic.js:322）：
 *   无线电骰点 N 清除的是「从当前位置起第 N 格」= 距离 (distance - N + 1)
 *   → 推进 1 格，同一架飞机所需的骰点就 -1
 *   → 所以「先放引擎」和「先放无线电」不是同一件事
 *
 * 做法：找真实决策点，把 rankMoves 给出的候选全打出来，
 * 看引擎类候选和无线电类候选各自的评估分。
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner'));
var { GameLogic: Logic } = loadGameEnvironment(ROOT);

var LIMIT = parseInt(process.argv[2] || '6', 10);
var shown = 0;

for (var g = 0; g < 400 && shown < LIMIT; g++) {
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

    // 只看有前方交通、且还没放引擎的局面
    var ahead = s.traffic.filter(function (d) { return d < s.distance; });
    if (ahead.length) {
      var ranked = Planner.rankMoves(s, role, Logic, cfg, { fair: false, coop: 1 });
      if (ranked.length > 1) {
        shown++;
        printCase(s, role, cfg, ranked);
        console.log('\n' + '═'.repeat(74) + '\n');
      }
    }

    var mv = Planner.searchBestMove(s, role, Logic, cfg, { fair: false, coop: 1 });
    if (!mv) break;
    var r = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    if (!r || !r.ok) break;
  }
}
console.log('共展示 ' + shown + ' 个决策点');

function printCase(s, role, cfg, ranked) {
  var free = s.dice[role].filter(function (d) { return !d.used && d.v > 0; })
    .map(function (d) { return d.v; });

  console.log('【' + (role === 'pilot' ? '机长' : '副驾') + ' 第' + s.round + '轮】 距机场 ' +
    s.distance + ' 格  跑道飞机距离 [' + s.traffic.join(',') + ']  咖啡 ' + s.coffee +
    '  手牌 [' + free.join(',') + ']');
  console.log('  我方已放：' + JSON.stringify(s.placements[role]));
  var you = s.placements[role === 'pilot' ? 'copilot' : 'pilot'];
  console.log('  对方已放：姿态' + (you.axis ? Logic.effVal(you.axis) : '-') +
    ' 引擎' + (you.engine ? Logic.effVal(you.engine) : '-'));

  // 关键：清障所需骰点，随推进变化
  var needNow = Planner.radioNeededValue(s, Logic);
  var sim = JSON.parse(JSON.stringify(s));
  sim.distance -= 1;
  var need1 = Planner.radioNeededValue(sim, Logic);
  sim.distance -= 1;
  var need2 = Planner.radioNeededValue(sim, Logic);
  console.log('  清障所需骰点：现在 ' + fmt(needNow) + ' / 推进1格后 ' + fmt(need1) +
    ' / 推进2格后 ' + fmt(need2) + '   ← 手牌 [' + free.join(',') + ']');

  console.log('  ── 候选（按评估分排序，前 12）──');
  ranked.slice(0, 12).forEach(function (x, i) {
    var m = x.move;
    var die = s.dice[role][m.dieIdx];
    var txt = Planner.PRIORITY_LABEL[m.slot] || m.slot;
    var note = '';
    if (m.slot === 'engine') note = '  ← 推进会改距离';
    if (m.slot.indexOf('radio') === 0) note = '  ← 清障';
    console.log('   ' + String(i + 1).padStart(2) + '. ' + txt +
      (m.val !== die.v ? '（' + die.v + '→' + m.val + '，咖啡' + (m.cp ? '+' : '-') + Math.abs(m.cp) + '）'
        : '（骰 ' + die.v + '）') +
      '   分 ' + Math.round(x.score) +
      (x.priorities && x.priorities.length ? '  [' + x.priorities.join(',') + ']' : '  [无标签]') + note);
  });
}

function fmt(v) { return v === null ? '无' : String(v); }
