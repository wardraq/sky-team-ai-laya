/* ============================================================
 * 天合小队 Sky Team —— AI 决策器回归测试 / 自博弈
 *
 * 用法：
 *   node test/ai/test-ai.js [局数] [配置]
 *   配置：ai-ai | ai-pilot | ai-copilot | base-base | all（默认 all）
 *
 * 说明：base 指逻辑层自带 test.js 里的启发式（逐颗贪心），
 *       作为「不做搜索」的对照基线。
 * ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
const Planner = require(path.join(ROOT, 'ai/planner'));

const { GameLogic: Logic, ScenarioRegistry } = loadGameEnvironment(ROOT);

const isNum = (x) => /^\d+$/.test(x || '');
const N = isNum(process.argv[2]) ? parseInt(process.argv[2], 10) : 50;
const MODE = process.argv[3] || 'all';

/* ---------- 对照组：项目自带启发式（逐颗贪心） ---------- */
function makeBasePlayer() {
  let lastAxis = { pilot: 3, copilot: 3 };
  function byVal(free, target) {
    return [...free].sort((a, b) => Math.abs(a.d.v - target) - Math.abs(b.d.v - target))[0];
  }
  function nextRadioSlot(p, role) {
    if (!p.radio) return 'radio';
    if (role === 'copilot' && !p.radio2) return 'radio2';
    return null;
  }
  function pickDieForSlot(free, role, slot) {
    const def = Logic.SLOTS[role][slot];
    if (!def || !def.limit) return free[Math.floor(Math.random() * free.length)];
    const ok = free.filter((x) => def.limit.indexOf(x.d.v) !== -1);
    return ok.length ? ok[Math.floor(Math.random() * ok.length)] : null;
  }
  function nextCoffeeSlot(s) {
    for (let i = 1; i <= Logic.CONFIG.COFFEE_SLOT_COUNT; i++) {
      if (s.placements.shared['coffee' + i] === null) return 'coffee' + i;
    }
    return null;
  }
  function findEquipMove(s, role, p, free) {
    if (role === 'pilot') {
      if (s.brakesAct < Logic.CONFIG.BRAKE_COUNT) {
        const bs = 'brake' + (s.brakesAct + 1);
        if (!p[bs]) {
          const bd = pickDieForSlot(free, role, bs);
          if (bd) return { target: bs, diePick: bd };
        }
      }
      for (let g = 1; g <= Logic.CONFIG.GEAR_COUNT; g++) {
        const gs = 'gear' + g;
        if (s.gearOn && !s.gearOn[gs] && !p[gs]) {
          const gd = pickDieForSlot(free, role, gs);
          if (gd) return { target: gs, diePick: gd };
        }
      }
    } else if (s.flapsAct < Logic.CONFIG.FLAP_COUNT) {
      const fs = 'flap' + (s.flapsAct + 1);
      if (!p[fs]) {
        const fd = pickDieForSlot(free, role, fs);
        if (fd) return { target: fs, diePick: fd };
      }
    }
    return null;
  }
  return function baseMove(s) {
    const role = s.currentPlayer;
    const free = s.dice[role].map((d, i) => ({ d, i })).filter((x) => !x.d.used);
    if (!free.length) return null;
    const p = s.placements[role];
    let target = null, diePick = null;

    if (!p.axis) {
      target = 'axis';
      const aim = s.axis > 0 ? 2 : s.axis < 0 ? 4 : 3;
      diePick = byVal(free, aim);
    } else if (!p.engine) {
      target = 'engine';
      diePick = (s.round === Logic.CONFIG.ROUNDS)
        ? [...free].sort((a, b) => a.d.v - b.d.v)[0]
        : byVal(free, 3);
    } else {
      const nearPlane = Logic.hasTraffic(s, s.distance - 1) || Logic.hasTraffic(s, s.distance - 2);
      const radioSlot = nearPlane ? nextRadioSlot(p, role) : null;
      if (radioSlot) {
        target = radioSlot;
        diePick = free.find((x) => x.d.v === 1) || free.find((x) => x.d.v === 2) || free[0];
      } else {
        const equip = findEquipMove(s, role, p, free);
        if (equip) { target = equip.target; diePick = equip.diePick; }
        else {
          const coffeeSlot = nextCoffeeSlot(s);
          if (coffeeSlot) { target = coffeeSlot; diePick = free[Math.floor(Math.random() * free.length)]; }
          else {
            const moves = [];
            Object.keys(Logic.SLOTS[role]).forEach((k) => {
              if (p[k] !== null) return;
              free.forEach((x) => { if (Logic.slotAllowed(s, role, k, x.d.v).ok) moves.push({ target: k, diePick: x }); });
            });
            Object.keys(Logic.SHARED_SLOTS).forEach((k) => {
              if (s.placements.shared[k] !== null) return;
              free.forEach((x) => { if (Logic.slotAllowed(s, role, k, x.d.v).ok) moves.push({ target: k, diePick: x }); });
            });
            if (!moves.length) return null;
            const pick = moves[Math.floor(Math.random() * moves.length)];
            target = pick.target; diePick = pick.diePick;
          }
        }
      }
    }
    if (!target || !diePick) return null;
    const opts = {};
    const def = Logic.getSlotDef(role, target);
    if (def.limit && def.limit.indexOf(diePick.d.v) === -1 && s.coffee > 0) {
      for (let plus = 0; plus <= s.coffee; plus++) {
        for (let minus = 0; plus + minus <= s.coffee; minus++) {
          const nv = diePick.d.v + plus - minus;
          if (nv >= 1 && nv <= 6 && def.limit.indexOf(nv) !== -1) {
            opts.coffeePlus = plus; opts.coffeeMinus = minus;
            plus = s.coffee + 1; break;
          }
        }
      }
    }
    const res = Logic.placeDie(s, role, diePick.i, target, opts);
    if (res.ok && target === 'axis') lastAxis[role] = diePick.d.v;
    return { ok: res.ok };
  };
}

/* ---------- AI 走子 ---------- */
function makeAIPlayer(opts) {
  return function aiMove(s) {
    Planner.applyReroll(s, Logic);
    const role = s.currentPlayer;
    const cfg = Logic.getScenarioConfig(s);
    const mv = Planner.searchBestMove(s, role, Logic, cfg, opts);
    if (!mv) return null;
    const res = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    return { ok: res.ok };
  };
}

/* ---------- 单局驱动 ---------- */
function step(s, players) {
  switch (s.phase) {
    case 'discuss':
      s.phase = 'roll';
      return { ok: true };
    case 'roll':
      Logic.rollDice(s, 'pilot');
      Logic.rollDice(s, 'copilot');
      s.phase = 'place';
      s.currentPlayer = s.startPlayer;
      return { ok: true };
    case 'place': {
      const r = s.currentPlayer;
      const mv = players[r](s);
      if (!mv) return { ok: false };
      return mv;
    }
    case 'reveal':
      Logic.resolveRound(s);
      return { ok: true };
    case 'roundEnd':
      Logic.nextRound(s);
      return { ok: true };
    default:
      return { ok: false };
  }
}

function runGame(roleCfg, aiOpts) {
  const s = Logic.newGame();
  Logic.beginRound(s);
  const players = {
    pilot: roleCfg.pilot === 'ai' ? makeAIPlayer(aiOpts) : makeBasePlayer(),
    copilot: roleCfg.copilot === 'ai' ? makeAIPlayer(aiOpts) : makeBasePlayer()
  };
  let guard = 0;
  while (s.phase !== 'win' && s.phase !== 'lose') {
    if (++guard > 600) return { stuck: true, phase: s.phase };
    const r = step(s, players);
    if (!r || !r.ok) return { stuck: true, phase: s.phase };
  }
  return { win: s.phase === 'win', reason: s.loseReason, rounds: s.round };
}

/* ---------- 跑一批 ---------- */
function batch(label, roleCfg, n, aiOpts) {
  let wins = 0, stuck = 0, errors = 0;
  const reasons = {};
  let roundSum = 0;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    try {
      const res = runGame(roleCfg, aiOpts);
      if (res.stuck) { stuck++; continue; }
      if (res.win) { wins++; roundSum += res.rounds; }
      else {
        const short = (res.reason || '未知').split('：')[0].split('（')[0];
        reasons[short] = (reasons[short] || 0) + 1;
      }
    } catch (e) { errors++; if (errors <= 3) console.error('  ! ' + e.message); }
  }
  const ms = Date.now() - t0;
  const decided = n - stuck - errors;
  const rate = decided > 0 ? (wins / decided * 100) : 0;
  console.log('\n【' + label + '】' + n + ' 局  ' + ms + 'ms  (' + (ms / n).toFixed(0) + 'ms/局)');
  console.log('  胜 ' + wins + ' (' + rate.toFixed(1) + '%)  负 ' + (decided - wins) + '  卡死 ' + stuck + '  异常 ' + errors);
  if (wins > 0) console.log('  胜局平均轮数 ' + (roundSum / wins).toFixed(2));
  const keys = Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]);
  if (keys.length) {
    keys.slice(0, 6).forEach((k) => {
      console.log('    ' + String(Math.round(reasons[k] / decided * 100)).padStart(3) + '%  ' + reasons[k] + '  ' + k);
    });
  }
  return rate;
}

console.log('=== Sky Team AI 回归测试 ===');
console.log('关卡：' + (ScenarioRegistry.defaultId || 'yul') + '  局数：' + N);

const configs = {
  'ai-ai':      { label: 'AI + AI（默认设置）',              roleCfg: { pilot: 'ai', copilot: 'ai' }, opts: { fair: false, coop: 1 } },
  'ai-ai-fair': { label: 'AI + AI（公平视角，看不到对手手牌）', roleCfg: { pilot: 'ai', copilot: 'ai' }, opts: { fair: true, coop: 1 } },
  'ai-pilot':   { label: 'AI 机长 + 基线副驾',                roleCfg: { pilot: 'ai', copilot: 'base' }, opts: { fair: false, coop: 1 } },
  'ai-copilot': { label: '基线机长 + AI 副驾',                roleCfg: { pilot: 'base', copilot: 'ai' }, opts: { fair: false, coop: 1 } },
  'base-base':  { label: '基线 + 基线（对照：项目自带启发式）', roleCfg: { pilot: 'base', copilot: 'base' }, opts: {} }
};

const chosen = MODE === 'all'
  ? ['ai-ai', 'ai-ai-fair', 'base-base', 'ai-pilot', 'ai-copilot']
  : [MODE];
chosen.forEach((k) => {
  if (!configs[k]) { console.log('未知配置：' + k + '（可选 ' + Object.keys(configs).join(' / ') + '）'); return; }
  batch(configs[k].label, configs[k].roleCfg, N, configs[k].opts);
});
console.log('\n✓ 完成');
