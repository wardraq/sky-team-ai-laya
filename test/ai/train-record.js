/* 跑一批训练局，整次训练写成一个文件。
 *   node test/ai/train-record.js [局数]
 * 种子 10007×局号+17。看不见对方未放的骰子。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '../..');
var loadEnv = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner.js'));
var env = loadEnv.loadGameEnvironment(ROOT);
var Logic = env.GameLogic;

var N = parseInt(process.argv[2] || '80', 10);
var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
var OPTS = { fair: true, coop: 1, samples: 1, seed: 0, macro: true, prob: true };
var HIDDEN_DIE_RNG = 0.5;

Planner.setRng(function () { return HIDDEN_DIE_RNG; });

function optsText() {
  var parts = Object.keys(OPTS).map(function (k) { return k + ' ' + OPTS[k]; });
  parts.push('隐藏骰子随机数 ' + HIDDEN_DIE_RNG);
  return parts.join('，');
}

function placedList(s, role) {
  var p = (s.placements && s.placements[role]) || {};
  var out = [];
  Object.keys(p).forEach(function (slot) {
    if (!p[slot]) return;
    var n = (p[slot].v || 0) + (p[slot].mod || 0);
    out.push(slotName(role, slot) + ' ' + n);
  });
  return out.length ? out.join('、') : '无';
}

function freeFaces(s, role) {
  var dice = (s.dice && s.dice[role]) || [];
  var out = [];
  for (var i = 0; i < dice.length; i++) {
    if (!dice[i].used && dice[i].v > 0) out.push(dice[i].v);
  }
  return out;
}

function decisionParams(s, role) {
  var other = role === 'pilot' ? 'copilot' : 'pilot';
  var own = freeFaces(s, role);
  var hidden = ((s.dice && s.dice[other]) || []).filter(function (d) { return !d.used; }).length;
  return [
    '参数：' + optsText(),
    '局面：' + boardLine(s),
    '自己未放 ' + (own.length ? own.join(' ') : '无') + '，自己已放 ' + placedList(s, role),
    '对方已放 ' + placedList(s, other) + '，对方未放 ' + hidden + ' 颗看不见',
    '公共已放 ' + placedList(s, 'shared')
  ];
}

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

function cn(n) {
  if (n >= 0 && n <= 10) return CN[n];
  return String(n);
}

function slotName(role, slot) {
  if (Logic.SHARED_SLOTS[slot]) return Logic.SHARED_SLOTS[slot].name || slot;
  var def = Logic.SLOTS[role] && Logic.SLOTS[role][slot];
  return def ? def.name : slot;
}

function boardLine(s) {
  var diceNeeded = (s.traffic || []).map(function (cell) { return s.distance - cell + 1; });
  diceNeeded.sort(function (a, b) { return a - b; });
  var planes = diceNeeded.length ? diceNeeded.join(' ') : '无';
  var where = s.landingRound ? '着陆轮，' : (s.waiting ? '等待，' : '');
  return where + '高度 ' + s.altitude
    + '，距离 ' + s.distance
    + '，姿态 ' + s.axis
    + '，蓝标记 ' + s.blueMark
    + '，橙标记 ' + s.orangeMark
    + '，刹车 ' + s.brakesAct
    + '，襟翼 ' + s.flapsAct
    + '，起落架 ' + s.gearAct
    + '，咖啡 ' + s.coffee
    + '，重置 ' + (s.reroll || 0)
    + '，飞机离待清飞机 ' + planes;
}

function num(n) {
  return String(Math.round(n));
}

function powText(bad, exp) {
  if (bad <= 0) return '0';
  if (bad >= 6) return '1';
  return '(' + bad + '/6)^' + exp;
}

function axisText(axis) {
  var lines = [];
  var p = powText(axis.bad ? axis.bad.length : 0, axis.n);
  if (axis.how === 'place') lines.push('这一手把姿态放成 ' + axis.own);
  else if (axis.how === 'placed') lines.push('姿态已经放成 ' + axis.own);
  else if (axis.how === 'best') {
    lines.push('这一手不放姿态，在剩下的骰子里取坠毁概率最小的点数 ' + axis.own);
    if (axis.face != null && axis.face !== axis.own) {
      lines.push('骰子 ' + axis.face + '，咖啡还剩 ' + axis.coffee + '，改成 ' + axis.own);
    }
  } else lines.push('没有剩下的骰子可放姿态');
  if (axis.seen) {
    lines.push('对方姿态已放 ' + axis.opp + '，新姿态 ' + axis.next);
    lines.push(axis.landing ? '着陆轮，新姿态是 0 则概率 0，否则 1' : '新姿态绝对值达到 3 则概率 1，否则 0');
    lines.push('姿态坠毁概率 ' + axis.p);
    return lines;
  }
  if (axis.faces) {
    lines.push('对方未放的点数是 ' + axis.faces.join('、'));
    lines.push(axis.safe ? '其中有安全点数，姿态坠毁概率 0' : '其中没有安全点数，姿态坠毁概率 1');
    return lines;
  }
  if (axis.bad) {
    lines.push('对方剩余 ' + axis.n + ' 颗，看不见点数，按 1 到 6');
    lines.push('不安全面 ' + (axis.bad.length ? axis.bad.join('、') : '无') + '，共 ' + axis.bad.length + ' 面');
    lines.push('姿态坠毁概率 = ' + p);
  }
  return lines;
}

function payText(pay, miss) {
  var once = powText(miss.bad, 4);
  var lines = ['单次失败 = ' + once];
  if (pay.how === 'none') lines.push('不欠，概率 0');
  else if (pay.how === 'short') lines.push('剩余 ' + pay.rounds + ' 次，欠 ' + pay.debt + ' 次，次数不够，概率 1');
  else if (pay.how === 'certain') lines.push('单次失败是 1，概率 1');
  else if (pay.how === 'exact') lines.push('剩余次数等于欠的次数 ' + pay.debt + '，概率 = 1 - (1 - 单次失败)^' + pay.debt);
  else lines.push('欠 ' + pay.debt + ' 次，剩余 ' + pay.rounds + ' 次，slack = ' + pay.rounds + ' - ' + pay.debt + ' + 1 = ' + pay.slack + '，概率 = (单次失败)^' + pay.slack);
  return lines;
}

function progText(prog) {
  var lines = [];
  var where = '高度 ' + prog.altitude + '，距离 ' + prog.distance + '，姿态 ' + prog.axis
    + '，蓝标记 ' + prog.blue + '，橙标记 ' + prog.orange;
  if (prog.how === 'win') return ['推演已胜，航程坠毁概率 0'];
  if (prog.how === 'lose') return ['推演已负，航程坠毁概率 1'];
  if (prog.how === 'spin') return [where, '姿态绝对值达到 3，航程坠毁概率 1'];
  if (prog.how === 'overshoot') return [where, '距离小于 0，航程坠毁概率 1'];
  if (prog.how === 'behind') return [where, '飞机在身后第 ' + prog.plane + ' 格，航程坠毁概率 1'];
  if (prog.how === 'landing') return [where, '着陆轮姿态不是 0 或距离不是 0，航程坠毁概率 1'];
  if (prog.how === 'landing-ok') return [where, '着陆轮姿态 0 且距离 0，航程坠毁概率 0'];
  if (prog.how === 'altitude') return [where, '高度已经是 0 但距离不是 0，航程坠毁概率 1'];
  if (prog.how === 'even') return [where, '还剩 ' + prog.n + ' 次下降，距离 ' + prog.distance + '，差 0，航程坠毁概率 0'];
  if (prog.how === 'hover' || prog.how === 'hover-out') {
    lines.push(where);
    lines.push(prog.how === 'hover-out'
      ? '已经在机场，还剩 ' + prog.n + ' 次下降，要悬停 ' + prog.n + ' 次'
      : '还剩 ' + prog.n + ' 次下降，距离 ' + prog.distance + '，差 ' + prog.gap + '，要还上 ' + prog.gap + ' 次悬停');
    lines.push('蓝标记 ' + prog.blue + '，悬停失败的不安全面 ' + prog.miss.bad);
    return lines.concat(payText(prog.pay, prog.miss));
  }
  if (prog.how === 'double') {
    lines.push(where);
    lines.push('还剩 ' + prog.n + ' 次下降，距离 ' + prog.distance + '，差 ' + prog.gap + '，要补上 ' + (-prog.gap) + ' 次两格');
    lines.push('橙标记 ' + prog.orange + '，两格失败的不安全面 ' + prog.miss.bad);
    return lines.concat(payText(prog.pay, prog.miss));
  }
  return [where];
}

function sideText(side) {
  var lines = ['咖啡消耗 ' + side.spend + ' × -1000 = ' + side.spendPoints];
  if (side.slotKind === 'axis') {
    lines.push(side.axisLead ? '先手姿态 +4000' : '后手姿态 +0');
  } else lines.push('姿态 +0');
  if (side.slotKind === 'engine') {
    lines.push(side.landing
      ? '着陆轮，引擎 +0'
      : (side.behind > 0
        ? '距离落后 ' + side.behind + ' 格，引擎 2500 × ' + (side.behind + 1) + ' = ' + side.engine
        : '距离不落后，引擎 2500 × 1 = ' + side.engine));
  } else lines.push('引擎 +0');
  if (side.slotKind === 'coffee') {
    lines.push('咖啡槽：现在 ' + side.coffeeNow + (side.coffeeNow < 3 ? '，未满，+1500' : '，已满，+0'));
  } else lines.push('咖啡槽 +0');
  if (side.slotKind === 'flap') {
    lines.push('襟翼 ' + side.flapN + '：' + (side.flapOn ? '已经激活，+0' : '+' + side.flap));
  } else lines.push('襟翼 +0');
  if (side.slotKind === 'gear') {
    lines.push('起落架第 ' + side.gearN + ' 个：' + (side.gearOn ? '已经激活，+0' : '+' + side.gear));
  } else lines.push('起落架 +0');
  if (side.slotKind === 'brake') {
    lines.push('刹车 ' + side.brakeN + '：' + (side.brakeOn ? '已经激活，+0' : '+' + side.brake));
  } else lines.push('刹车 +0');
  if (side.slotKind === 'radio') {
    if (!side.count) {
      lines.push('清飞机距离 ' + side.clearDist + '，离机场 ' + side.planeAt + ' 格，飞机 0 架，+0');
    } else {
      lines.push('清飞机距离 ' + side.clearDist + '，底分 max(1000, 5000 - ' + side.clearDist + ' × ' + side.step + ') = ' + side.base);
      lines.push('这一格 ' + side.count + ' 架，多 ' + Math.max(0, side.count - 1) + ' 架 × 500 = ' + side.bonus);
      lines.push('清飞机 +' + side.radio);
    }
  } else lines.push('清飞机 +0');
  lines.push('副分 = ' + side.total);
  return lines;
}

function reasonLines(parts, top, role) {
  var lines = [];
  if (!parts) return ['没有打分'];
  if (parts.kind === 'win') {
    lines.push('合计 10000000');
    lines.push('推演结果是胜，分数 = 10000000，副分不加');
  } else if (parts.kind === 'lose') {
    lines.push('合计 ' + num(-10000000 + parts.side.total));
    lines.push('推演结果是负，分数 = -10000000 + 副分');
    sideText(parts.side).forEach(function (line) { lines.push(line); });
  } else {
    var axisFormula = parts.axis.bad ? powText(parts.axis.bad.length, parts.axis.n) : String(parts.axis.p);
    var progFormula = '0';
    if (parts.prog.p === 1) progFormula = '1';
    else if (parts.prog.miss && parts.prog.pay && (parts.prog.pay.how === 'once' || parts.prog.pay.how === 'power')) {
      progFormula = '(' + powText(parts.prog.miss.bad, 4) + ')^' + parts.prog.pay.slack;
    } else if (parts.prog.p !== 0) progFormula = String(parts.prog.p);
    lines.push('合计 ' + num(parts.total));
    lines.push('主分 ' + num(parts.main) + ' = (1 - ' + axisFormula + ') * (1 - ' + progFormula + ') * 100000');
    lines.push('姿态');
    axisText(parts.axis).forEach(function (line) { lines.push(line); });
    lines.push('航程');
    progText(parts.prog).forEach(function (line) { lines.push(line); });
    sideText(parts.side).forEach(function (line) { lines.push(line); });
  }
  if (top && top.move) {
    lines.push('排序更高的一手：' + slotName(role, top.move.slot) + ' ' + top.move.val + '，合计 ' + num(top.score));
  }
  return lines;
}

function resultText(role, mv) {
  var text = slotName(role, mv.slot) + ' ' + mv.val;
  if (mv.face != null && mv.face !== mv.val) text += '，骰子 ' + mv.face;
  if (mv.cp) text += '，咖啡 +' + mv.cp;
  if (mv.cm) text += '，咖啡 -' + mv.cm;
  return text;
}

function failText(round, reason) {
  var head = '第' + cn(round) + '轮 ';
  var text = reason || '未知';
  if (text.indexOf('姿态失衡') === 0) {
    var tilt = text.match(/（[^）]+）/);
    return head + '姿态失衡' + (tilt ? tilt[0] : '');
  }
  if (text.indexOf('着陆速度过快') === 0) {
    var speed = text.replace(/^着陆速度过快！?/, '').trim();
    return head + '着陆速度过快' + (speed ? '，' + speed : '');
  }
  if (text.indexOf('高度归零') === 0) return head + '高度归零仍未到达机场';
  if (text.indexOf('碰撞') === 0) {
    var hit = text.replace(/^碰撞！?/, '').trim();
    return head + '碰撞' + (hit ? '，' + hit : '');
  }
  if (text.indexOf('冲出') >= 0) return head + '冲出跑道';
  return head + text.replace(/！$/, '');
}

function rerollLines(spent) {
  var lines = ['重掷：消耗 1 枚，还剩 ' + spent.left];
  ['pilot', 'copilot'].forEach(function (role) {
    var who = role === 'pilot' ? '机长' : '副驾';
    var idx = spent.picks[role] || [];
    if (!idx.length) { lines.push(who + '跳过'); return; }
    var parts = idx.map(function (i) {
      return (i + 1) + ' 号 ' + spent.before[role][i] + '→' + spent.after[role][i];
    });
    lines.push(who + '重掷 ' + parts.join('，'));
  });
  return lines;
}

function play(seed) {
  return withSeed(seed, function () {
    var s = Logic.newGame();
    Logic.beginRound(s);
    var guard = 0;
    var rounds = [];
    var cur = null;
    var steps = { pilot: 0, copilot: 0 };
    while (s.phase !== 'win' && s.phase !== 'lose' && guard++ < 400) {
      if (s.phase === 'discuss') { s.phase = 'roll'; continue; }
      if (s.phase === 'roll') {
        Logic.rollDice(s, 'pilot');
        Logic.rollDice(s, 'copilot');
        s.phase = 'place';
        s.currentPlayer = s.startPlayer;
        steps = { pilot: 0, copilot: 0 };
        cur = {
          round: s.round,
          first: s.startPlayer,
          board: boardLine(s),
          dice: {
            pilot: s.dice.pilot.map(function (d) { return d.v; }),
            copilot: s.dice.copilot.map(function (d) { return d.v; })
          },
          moves: []
        };
        rounds.push(cur);
        continue;
      }
      if (s.phase === 'reveal') { Logic.resolveRound(s); continue; }
      if (s.phase === 'roundEnd') { Logic.nextRound(s); continue; }
      var role = s.currentPlayer;
      var spent = Planner.applyReroll(s, Logic);
      if (spent && cur) cur.moves.push({ kind: 'reroll', lines: rerollLines(spent) });
      var cfg = Logic.getScenarioConfig(s);
      var picked = Planner.searchDecision(s, role, Logic, cfg, OPTS);
      var mv = picked && picked.move;
      if (!mv) return { stuck: true, rounds: rounds, round: s.round, reason: '没有合法落子' };
      var face = s.dice[role][mv.dieIdx] ? s.dice[role][mv.dieIdx].v : null;
      steps[role]++;
      var recorded = {
        slot: mv.slot, val: mv.val, cp: mv.cp, cm: mv.cm, face: face
      };
      cur.moves.push({
        role: role,
        n: steps[role],
        text: resultText(role, recorded),
        params: decisionParams(s, role),
        reasons: reasonLines(picked.parts, picked.top, role)
      });
      var res = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
      if (!res || !res.ok) return { stuck: true, rounds: rounds, round: s.round, reason: (res && res.why) || '落子失败' };
    }
    return {
      win: s.phase === 'win',
      stuck: s.phase !== 'win' && s.phase !== 'lose',
      round: s.round,
      reason: s.loseReason || '',
      rounds: rounds
    };
  });
}

function formatGame(index, seed, game) {
  var lines = ['第' + index + '局：', '    种子：' + seed];
  if (game.stuck) {
    lines.push('    结局：卡死');
    lines.push('    失败原因：' + failText(game.round, game.reason));
  } else if (game.win) {
    lines.push('    结局：胜');
  } else {
    lines.push('    结局：负');
    lines.push('    失败原因：' + failText(game.round, game.reason));
  }
  (game.rounds || []).forEach(function (rd) {
    lines.push('  第' + cn(rd.round) + '轮：');
    lines.push('      先手：' + (rd.first === 'pilot' ? '机长' : '副驾'));
    lines.push('      局面：' + rd.board);
    lines.push('      机长骰子：' + rd.dice.pilot.join(' ') + '，副驾骰子：' + rd.dice.copilot.join(' '));
    rd.moves.forEach(function (mv) {
      if (mv.kind === 'reroll') {
        (mv.lines || []).forEach(function (line) {
          lines.push('      ' + line);
        });
        return;
      }
      var who = mv.role === 'pilot' ? '机长' : '副驾';
      lines.push('      ' + who + '第' + cn(mv.n) + '步骰子决策：' + mv.text);
      (mv.params || []).forEach(function (line) {
        lines.push('          ' + line);
      });
      (mv.reasons || []).forEach(function (line) {
        lines.push('          ' + line);
      });
    });
  });
  return lines.join('\n');
}

function stamp(d) {
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

var games = [];
var wins = 0;
var t0 = Date.now();
for (var i = 0; i < N; i++) {
  var seed = 10007 * (i + 1) + 17;
  var game = play(seed);
  if (game.win) wins++;
  games.push(formatGame(i + 1, seed, game));
  if ((i + 1) % 10 === 0 || i + 1 === N) {
    console.log('局 ' + (i + 1) + '/' + N + '  胜 ' + wins + '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
}

var when = new Date();
var header = [
  '训练 ' + when.getFullYear() + '-' + (when.getMonth() + 1) + '-' + when.getDate()
    + ' ' + when.getHours() + ':' + (when.getMinutes() < 10 ? '0' : '') + when.getMinutes(),
  N + ' 局，种子 10007×局号+17',
  '看不见对方未放的骰子，概率开，宏观开',
  '飞机离待清飞机：每个数字是清这架飞机要的骰子点数，1 是自己所在格，同一个数字出现几次就是这个点数还能清几架',
  '胜 ' + wins + '，负 ' + (N - wins),
  ''
].join('\n');

var dir = path.join(ROOT, 'data/train-records');
fs.mkdirSync(dir, { recursive: true });
var file = path.join(dir, stamp(when) + '.txt');
fs.writeFileSync(file, header + games.join('\n\n') + '\n');
console.log('写入 ' + file);
console.log('胜 ' + wins + '/' + N + '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
