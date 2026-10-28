/* 抓两个真实决策点（中局 + 着陆轮），把喂给 laya 的输入原样落盘。
 * 用法：node test/ai/laya-ablation-dump.js [局数]
 * 产出：test/ai/.ablation-payload.json（供 test/ai/laya-ablation.py 消费）
 */
/* 抓两个真实决策点（中局 + 着陆轮），把 laya 的输入原样 dump 出来 */
const path = require('path');
const ROOT = require('path').resolve(__dirname, '../..');
const { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
const Planner = require(path.join(ROOT, 'ai/planner'));
const Prompt = require(path.join(ROOT, 'ai/laya-prompt'));
const { GameLogic: Logic } = loadGameEnvironment(ROOT);

function safePlace(s, r, mv) {
  const res = Logic.placeDie(s, r, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
  return res && res.ok;
}

function snapshot(s, role, tag) {
  const cfg = Logic.getScenarioConfig(s);
  const ranked = Planner.rankMoves(s, role, Logic, cfg, { fair: false, coop: 1 });
  const active = Planner.activePriorities(ranked);
  const options = Prompt.renderPriorities(s, role, Logic, cfg, active);
  const best = Planner.bestMove(ranked, null, { fair: false, coop: 1 });
  const plannerTop = Planner.ownPriority(ranked, best);
  return {
    plannerTop: plannerTop,
    tag: tag,
    role: role,
    rounds: cfg.ROUNDS,
    state: Prompt.describeState(s, role, Logic),
    instructions: Prompt.instructionsFor(role, cfg.ROUNDS),
    options: options.map(o => ({ key: o.key, text: o.text, id: o.id })),
    meta: {
      round: s.round,
      landingRound: !!s.landingRound,
      axis: s.axis,
      altitude: s.altitude,
      distance: s.distance,
      blueMark: s.blueMark,
      orangeMark: s.orangeMark,
      coffee: s.coffee,
      legality: ranked.length,
      activePriorities: active
    },
    candidates: options.map(o => o.id)
  };
}

const best = { mid: null, midScore: -1, landing: null, landingScore: -1 };
let maxActive = 0;

for (let game = 0; game < 400; game++) {
  const s = Logic.newGame();
  Logic.beginRound(s);
  let g = 0;
  while (s.phase !== 'win' && s.phase !== 'lose' && g++ < 600) {
    if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
    if (s.phase === 'roll') {
      Logic.rollDice(s, 'pilot'); Logic.rollDice(s, 'copilot');
      s.phase = 'place'; s.currentPlayer = s.startPlayer; continue;
    }
    if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
    if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }

    const r = s.currentPlayer;
    const cfg = Logic.getScenarioConfig(s);
    const ranked = Planner.rankMoves(s, r, Logic, cfg, { fair: false, coop: 1 });
    const active = Planner.activePriorities(ranked);
    if (active.length > maxActive) maxActive = active.length;

    // 选项多 + 合法落子多 = 越有价值
    const score = active.length * 1000 + ranked.length;
    if (s.landingRound) {
      if (score > best.landingScore) { best.landingScore = score; best.landing = snapshot(s, r, 'landing'); }
    } else {
      if (score > best.midScore) { best.midScore = score; best.mid = snapshot(s, r, 'midgame'); }
    }

    const mv = Planner.searchBestMove(s, r, Logic, cfg, { fair: false, coop: 1 });
    if (!mv || !safePlace(s, r, mv)) break;
  }
}

const out = [best.mid, best.landing].filter(Boolean);
const dest = path.join(__dirname, '.ablation-payload.json');
require('fs').writeFileSync(dest, JSON.stringify(out, null, 2));
console.error('全程观察到的最大要事数 = ' + maxActive);
console.error('已写出 ' + dest);
out.forEach(x => console.error('  [' + x.tag + '] ' + x.role + '  选项 ' + x.options.length +
  '  合法落子 ' + x.meta.legality + '  要事 ' + x.meta.activePriorities.join('/')));
