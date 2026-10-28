/* 受控案例：只有「先推进，再用同一轮剩下的骰子清障」才成立。
 *
 * 规则依据：
 *   radioTarget(distance, val) = distance - (val - 1)      // game-logic.js:323
 *   即「骰点 N 清掉从当前位置数第 N 格」→ 推进 1 格，同一架飞机所需骰点 -1
 *
 * 构造：
 *   distance = 5，跑道上有飞机在距离 3
 *     → 不推进：需要骰点 5-3+1 = 3   （手牌没有 3，清不掉）
 *     → 推进 1 格到 distance 4：需要骰点 4-3+1 = 2  （手牌有 2，能清）
 *   副驾已放引擎 4；我方放引擎 2 → 和 = 6 = 蓝标记 → 推进 1 格
 *
 * 用法：node test/ai/lookahead-case.js
 */
'use strict';

var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner'));
var Eval = require(path.join(ROOT, 'ai/evaluate'));
var { GameLogic: Logic } = loadGameEnvironment(ROOT);

function build() {
  var s = Logic.newGame('builtin');
  Logic.beginRound(s);
  s.round = 3;
  s.phase = 'place';
  s.startPlayer = 'pilot';
  s.currentPlayer = 'pilot';

  s.altitude = 4000;
  s.distance = 9;
  s.traffic = [3, 0];
  s.axis = 0;
  s.blueMark = 6;
  s.orangeMark = 12;
  s.coffee = 0;

  s.dice.pilot = [{ v: 2, used: false }, { v: 6, used: false },
                  { v: 1, used: false }, { v: 1, used: false }];
  s.dice.copilot = [{ v: 3, used: false }, { v: 4, used: false },
                    { v: 6, used: false }, { v: 1, used: false }];

  // 姿态已在本轮协调完（避免干扰）
  s.placements.pilot.axis = { v: 3, mod: 0 };
  s.placements.copilot.axis = { v: 3, mod: 0 };
  s.roundResolved.axis = true;

  // 副驾已经放了引擎 4
  s.placements.copilot.engine = { v: 4, mod: 0 };

  return s;
}

var s = build();
var cfg = Logic.getScenarioConfig(s);

console.log('━'.repeat(72));
console.log('受控局面');
console.log('━'.repeat(72));
console.log('  距机场 ' + s.distance + ' 格     跑道飞机距离 [' + s.traffic.join(', ') + ']');
console.log('  蓝标记 ' + s.blueMark + '（引擎和 ≥ 它 → 前进 1 格）  橙标记 ' + s.orangeMark);
console.log('  我方手牌 [' + s.dice.pilot.map(function (d) { return d.v; }).join(', ') + ']   咖啡 ' + s.coffee);
console.log('  副驾已放引擎 ' + Logic.effVal(s.placements.copilot.engine));
console.log();
console.log('  清障所需骰点 = distance - 目标距离 + 1，但骰点只能是 1~6');
console.log('    不推进（距 9）：清距离 3 的飞机需要骰点 ' + (9 - 3 + 1) + '  → 超出 1~6，放不出来 ✗');
console.log('    推进 1 格（距 8）：需要骰点 ' + (8 - 3 + 1) + '                → 手牌有 6 ✓');
console.log('  推进条件：我方引擎 + 副驾 4 ≥ 蓝标记 ' + s.blueMark + '  →  我方引擎 ≥ ' + (s.blueMark - 4));
console.log('  ⚠ 顺序不可换：一旦先用掉 radio 槽，推进后就再也清不掉了');
console.log();

/* ---------- 对照：两条路线手动模拟 ---------- */
console.log('━'.repeat(72));
console.log('路线对照（都补完本轮，用同一个评估函数裁判）');
console.log('━'.repeat(72));

function playRoute(label, firstMove) {
  var t = JSON.parse(JSON.stringify(s));
  var r = Logic.placeDie(t, 'pilot', firstMove.dieIdx, firstMove.slot,
    { coffeePlus: firstMove.cp || 0, coffeeMinus: firstMove.cm || 0 });
  if (!r || !r.ok) { console.log('  ' + label + '：落子非法'); return; }
  var afterDist = t.distance;
  var trafficAfter = t.traffic.slice();

  Planner.rollout(t, Logic, cfg, { aiRole: 'pilot', coop: 1 });
  var v = Eval.evaluate(t, Logic, cfg);
  console.log('  ' + label);
  console.log('     第一步 ' + firstMove.slot + ' = ' + firstMove.val +
    '  →  距离 ' + afterDist + '，跑道 [' + trafficAfter.join(', ') + ']');
  console.log('     本轮走完：距离 ' + t.distance + '，跑道 [' + t.traffic.join(', ') + ']' +
    '，起落架 ' + t.gearAct + '/3，刹车 ' + t.brakesAct + '/3');
  console.log('     评分 ' + Math.round(v));
}

// 找出手牌里对应的骰子下标
function dieIdxOf(val, n) {
  var c = 0;
  for (var i = 0; i < s.dice.pilot.length; i++) {
    if (s.dice.pilot[i].v === val) { c++; if (c === n) return i; }
  }
  return -1;
}

playRoute('A. 先放无线电 6（不推进 → 需要骰点 7，超出范围，等于浪费）',
  { dieIdx: dieIdxOf(6, 1), slot: 'radio', val: 6 });
playRoute('B. 先放引擎 2（推进 1 格到距 8）→ 再用 6 清距离 3',
  { dieIdx: dieIdxOf(2, 1), slot: 'engine', val: 2 });

/* ---------- planner 实际选择 ---------- */
console.log();
console.log('━'.repeat(72));
console.log('planner 的候选（前 10）');
console.log('━'.repeat(72));

var ranked = Planner.rankMoves(s, 'pilot', Logic, cfg, { fair: false, coop: 1 });
ranked.slice(0, 10).forEach(function (x, i) {
  var m = x.move;
  var die = s.dice.pilot[m.dieIdx];
  var label = Planner.PRIORITY_LABEL[m.slot] || m.slot;
  console.log('  ' + String(i + 1).padStart(2) + '. ' + label + ' = ' + m.val +
    '（骰 ' + die.v + '）   分 ' + Math.round(x.score) +
    (x.priorities && x.priorities.length ? '  [' + x.priorities.join(',') + ']' : '  [无标签]') +
    (m.slot === 'engine' ? '   ← 推进' : '') +
    (m.slot.indexOf('radio') === 0 ? '   ← 清障' : ''));
});

var best = Planner.searchBestMove(s, 'pilot', Logic, cfg, { fair: false, coop: 1 });
console.log();
console.log('  ▶ planner 最终选择：' + best.slot + ' = ' + best.val +
  '（骰 ' + s.dice.pilot[best.dieIdx].v + '）');
console.log('  ▶ 期望（如果预判到位）：engine = 2 先推进，再用 6 清距离 3');

/* ---------- 同分候选的终态到底一不一样 ---------- */
console.log();
console.log('━'.repeat(72));
console.log('同分候选的终态对比（判断「同分」是巧合还是评估太粗）');
console.log('━'.repeat(72));

var top = ranked.slice(0, 6);
top.forEach(function (x) {
  var t = JSON.parse(JSON.stringify(s));
  var r = Logic.placeDie(t, 'pilot', x.move.dieIdx, x.move.slot,
    { coffeePlus: x.move.cp || 0, coffeeMinus: x.move.cm || 0 });
  if (!r || !r.ok) return;
  Planner.rollout(t, Logic, cfg, { aiRole: 'pilot', coop: 1 });
  console.log('  ' + (Planner.PRIORITY_LABEL[x.move.slot] || x.move.slot) + ' = ' + x.move.val +
    '   分 ' + Math.round(x.score));
  console.log('      终态：距 ' + t.distance + '  跑道 [' + t.traffic.join(',') + ']' +
    '  起落架 ' + t.gearAct + '/3  襟翼 ' + t.flapsAct + '/4  刹车 ' + t.brakesAct + '/3' +
    '  姿态 ' + t.axis + '  咖啡 ' + t.coffee + '  高度 ' + t.altitude);
});
