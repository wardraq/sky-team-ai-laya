/* ============================================================
 * 要事标注、提示词和旁路门禁
 *   node test/ai/test-ai-priority.js
 * ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
const Planner = require(path.join(ROOT, 'ai/planner'));
const Prompt = require(path.join(ROOT, 'ai/laya-prompt'));
const LayaClient = require(path.join(ROOT, 'ai/laya-client'));
const { createAIPlayer } = require(path.join(ROOT, 'ai/ai-player'));
const { GameLogic: Logic } = loadGameEnvironment(ROOT);

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok  ' + msg); return; }
  failed++;
  console.error('  FAIL  ' + msg);
}

function baseState() {
  const s = Logic.newGame('yul');
  s.phase = 'place';
  s.currentPlayer = 'copilot';
  s.round = 1;
  s.axis = 0;
  s.distance = 6;
  s.altitude = 6000;
  s.coffee = 0;
  s.traffic = [];
  s.dice.copilot = [
    { v: 1, used: false }, { v: 6, used: false },
    { v: 3, used: false }, { v: 4, used: false }
  ];
  s.dice.pilot = [
    { v: 2, used: false }, { v: 2, used: false },
    { v: 2, used: false }, { v: 2, used: false }
  ];
  s.placements.pilot.axis = { v: 1, mod: 0 };
  return s;
}

function tagsOf(ranked, slot, val) {
  const hit = ranked.filter((r) => r.move.slot === slot && r.move.val === val);
  return hit.length ? hit[0].priorities : null;
}

console.log('=== 要事标注 ===');
{
  const s = baseState();
  s.traffic = [4];
  const cfg = Logic.getScenarioConfig(s);
  const ranked = Planner.rankMoves(s, 'copilot', Logic, cfg, { fair: true, coop: 0.5, samples: 1 });
  const active = Planner.activePriorities(ranked);
  check(tagsOf(ranked, 'axis', 1).indexOf('match_axis') !== -1, '姿态 1 标成配平');
  check(tagsOf(ranked, 'radio', 3).indexOf('clear_hazard') !== -1, '无线电 3 标成清飞机（距离 4）');
  check(active.indexOf('match_axis') !== -1 && active.indexOf('clear_hazard') !== -1, '两件要事同时成立');
  const coffee = ranked.filter((r) => r.move.slot.indexOf('coffee') === 0);
  check(coffee.length > 0 && coffee.every((r) => r.priorities.length === 0), '咖啡不单独成要事');
  const axisMove = Planner.bestMove(ranked, 'match_axis', { seed: 0 });
  check(axisMove && axisMove.slot === 'axis' && axisMove.val === 1, '按配平过滤后只落姿态 1');
  const radioMove = Planner.bestMove(ranked, 'clear_hazard', { seed: 0 });
  check(radioMove && (radioMove.slot === 'radio' || radioMove.slot === 'radio2'), '按清飞机过滤后落无线电');
}

console.log('=== 必填槽 / 设备 / 着陆 ===');
{
  const s = baseState();
  s.dice.copilot = [
    { v: 4, used: false }, { v: 1, used: true },
    { v: 2, used: true }, { v: 3, used: true }
  ];
  s.placements.pilot.axis = null;
  const cfg = Logic.getScenarioConfig(s);
  const ranked = Planner.rankMoves(s, 'copilot', Logic, cfg, { fair: true, samples: 1 });
  check(ranked.length > 0 && ranked.every((r) => r.priorities.indexOf('fill_mandatory') !== -1),
    '骰子只够必填槽时，每手都标成先填必填槽');
  check(ranked.every((r) => r.move.slot === 'axis' || r.move.slot === 'engine'), '此时不再出现非必填槽');
}
{
  const s = baseState();
  s.placements.pilot.axis = null;
  s.altitude = 1000;
  s.dice.copilot[0] = { v: 2, used: false };
  const cfg = Logic.getScenarioConfig(s);
  const ranked = Planner.rankMoves(s, 'copilot', Logic, cfg, { fair: true, samples: 1 });
  const flap = ranked.filter((r) => r.move.slot === 'flap1');
  check(flap.length > 0 && flap.every((r) => r.priorities.indexOf('equipment') !== -1),
    '襟翼落后于剩余轮数时标成补设备');
}
{
  const s = baseState();
  s.placements.pilot.axis = null;
  s.landingRound = true;
  s.altitude = 0;
  s.distance = 0;
  const cfg = Logic.getScenarioConfig(s);
  const ranked = Planner.rankMoves(s, 'copilot', Logic, cfg, { fair: true, samples: 1 });
  const eng = ranked.filter((r) => r.move.slot === 'engine');
  check(eng.length > 0 && eng.every((r) => r.priorities.indexOf('landing_engine') !== -1),
    '着陆轮未放引擎时标成着陆压速');
}

console.log('=== 提示词 ===');
{
  const s = baseState();
  s.traffic = [4];
  const cfg = Logic.getScenarioConfig(s);
  const text = Prompt.describeState(s, 'copilot', Logic);
  const instr = Prompt.instructionsFor('copilot', cfg.ROUNDS);
  const pilotInstr = Prompt.instructionsFor('pilot', 4);
  check(instr.indexOf('副驾') !== -1 && instr.indexOf('7') !== -1, '副驾指令带上关卡轮数');
  check(pilotInstr.indexOf('机长') !== -1 && pilotInstr.indexOf('4') !== -1, '机长指令不用写死的 7 轮');
  check(text.indexOf('你手上的骰子：1、6、3、4') !== -1, '只列出自己的骰子');
  check(text.indexOf('2、2') === -1 && /机长本轮已放置：姿态 1\s*$/.test(text),
    '局面里没有对手未放的点数');
  const options = Prompt.renderPriorities(s, 'copilot', Logic, cfg, ['match_axis', 'clear_hazard']);
  const blob = options.map((o) => o.text).join('\n');
  check(options[0].id === 'match_axis' && blob.indexOf('姿态 1') !== -1, '配平选项写出对手已放的姿态');
  check(blob.indexOf('距离 4') !== -1, '清飞机选项写出挡路的距离');
  check(!/分|最高|score/i.test(blob), '选项里没有规划器分数');
}

console.log('=== 旁路与置信度门禁 ===');
{
  const ranked = [
    { move: { dieIdx: 0, slot: 'axis', val: 1, cp: 0, cm: 0 }, score: 10, priorities: ['match_axis'] },
    { move: { dieIdx: 2, slot: 'radio', val: 3, cp: 0, cm: 0 }, score: 5, priorities: ['clear_hazard'] }
  ];
  const info = { ranked: ranked, asked: true, choice: 'clear_hazard', confidence: 0.95 };
  const shadow = createAIPlayer(Logic, { layaApply: false });
  const kept = shadow.resolvePlace(info);
  check(kept.move.slot === 'axis' && kept.applied === false, '旁路时仍落规划器的最高分');
  const apply = createAIPlayer(Logic, { layaApply: true, layaMinConf: 0.6 });
  const taken = apply.resolvePlace(info);
  check(taken.move.slot === 'radio' && taken.applied === true, '置信度够才改用 laya 的要事');
  const low = apply.resolvePlace({ ranked: ranked, asked: true, choice: 'clear_hazard', confidence: 0.2 });
  check(low.move.slot === 'axis' && low.applied === false, '置信度不够就退回规划器');
  check(shadow.stats.agree === 0 && shadow.stats.asked === 1, '旁路记录了不一致');
}

console.log('=== fair / coop / samples 传给同一次排序 ===');
{
  const s = baseState();
  const orig = Planner.rankMoves;
  let seen = null;
  Planner.rankMoves = function (st, role, logic, cfg, opts) {
    seen = opts;
    return orig(st, role, logic, cfg, opts);
  };
  LayaClient.choosePriority(Logic, s, 'copilot', { fair: false, coop: 0.25, samples: 2 })
    .then(function (info) {
      Planner.rankMoves = orig;
      check(!!info && info.asked === false, '只有一件要事时不问 laya');
      check(seen && seen.fair === false && seen.coop === 0.25 && seen.samples === 2,
        '排序使用调用方的 fair、coop、samples');
      if (failed) {
        console.error('\n' + failed + ' 项失败');
        process.exit(1);
      }
      console.log('\n✓ 通过');
    })
    .catch(function (e) {
      Planner.rankMoves = orig;
      console.error(e);
      process.exit(1);
    });
}
