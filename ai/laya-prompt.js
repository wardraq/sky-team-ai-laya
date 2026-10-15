/* ============================================================
 * 天合小队 Sky Team —— 把局面渲染成 laya 能读的文字
 *
 * laya 是「给若干选项、选一个」的决策引擎，不是生成模型。
 * 所以这里的职责就是把「这盘棋现在什么样」和「有哪几个落子可选」
 * 翻译成一段简短的自然语言 + 一组带描述的选项。
 *
 * 注意 token 预算：laya 的「指令 + 全部选项」共享 head_max_len
 * （英文 192 / 多语 256）。选项越多每个分到的预算越少，
 * 超过 20 个选项精度会崩，所以候选要压到 6~8 个。
 * ============================================================ */
'use strict';

var SLOT_LABEL = {
  axis: '姿态', engine: '引擎', radio: '无线电', radio2: '无线电右',
  gear1: '起落架1-2', gear2: '起落架3-4', gear3: '起落架5-6',
  brake1: '刹车2', brake2: '刹车4', brake3: '刹车6',
  flap1: '襟翼1-2', flap2: '襟翼2-3', flap3: '襟翼4-5', flap4: '襟翼5-6',
  coffee1: '集中精力', coffee2: '集中精力', coffee3: '集中精力'
};

var INSTRUCTIONS =
  '你是 Sky Team 里的副驾驶。机长和副驾合作，要在 7 轮内把客机安全降落到蒙特利尔：' +
  '让高度和距离同时归零，清空跑道上的飞机，激活全部起落架与襟翼，' +
  '并在着陆轮把双方引擎点数之和压到刹车值以下。' +
  '姿态靠双方点数之差调整：机长点数减副驾点数应等于当前姿态值，才能保持水平。' +
  '请只选一个对本次降落最有利的落子。';

/**
 * 把当前局面写成一段话给 laya 看。
 */
function describeState(s, role, Logic) {
  var cfg = Logic.getScenarioConfig(s);
  var isPilot = role === 'pilot';
  var meName = isPilot ? '机长' : '副驾';
  var foeName = isPilot ? '副驾' : '机长';

  var free = [];
  s.dice[role].forEach(function (d) { if (!d.used && d.v > 0) free.push(d.v); });

  var L = [];
  L.push('你是' + meName + '，第 ' + s.round + '/' + cfg.ROUNDS + ' 轮' +
    (s.landingRound ? '（着陆轮）' : ''));
  L.push('高度 ' + s.altitude + ' 英尺，距机场 ' + s.distance + ' 格，姿态 ' + s.axis +
    '（0 表示水平，正数偏副驾一侧）');
  L.push('蓝标记 ' + s.blueMark + '（引擎和达到它就前进 1 格），橙标记 ' + s.orangeMark +
    '（超过它前进 2 格）');
  L.push('起落架 ' + s.gearAct + '/' + cfg.GEAR_COUNT +
    '，襟翼 ' + s.flapsAct + '/' + cfg.FLAP_COUNT +
    '，刹车 ' + s.brakesAct + '/' + cfg.BRAKE_COUNT);
  if (s.landingRound) {
    L.push('着陆轮限速：双方引擎和必须严格小于 ' + Logic.brakeValue(s));
  }
  L.push('跑道上飞机的距离：' + (s.traffic.length ? s.traffic.join('、') : '无'));
  L.push('可用咖啡 ' + s.coffee + '（每点可把一颗骰子加减 1），重掷标记 ' + s.reroll);
  L.push('你手上的骰子：' + (free.length ? free.join('、') : '已放完'));

  var foeP = s.placements[isPilot ? 'copilot' : 'pilot'];
  var bits = [];
  if (foeP.axis) bits.push('姿态 ' + Logic.effVal(foeP.axis));
  if (foeP.engine) bits.push('引擎 ' + Logic.effVal(foeP.engine));
  L.push(foeName + '本轮已放置：' + (bits.length ? bits.join('、') : '还没放'));

  return L.join('\n');
}

/** 把一个候选动作写成一句人话 */
function describeMove(s, role, Logic, m) {
  var name = SLOT_LABEL[m.slot] || m.slot;
  var die = s.dice[role][m.dieIdx];
  var raw = die ? die.v : m.val;
  if (m.val === raw) return name + ' 放点数 ' + m.val;
  return name + ' 把 ' + raw + ' 用咖啡改到 ' + m.val;
}

/**
 * 从排序好的候选里取前 K 个，转成 laya 的选项。
 * 只保留「描述不同」的候选，避免一堆同义选项互相挤压 token 预算。
 */
function renderOptions(s, role, Logic, ranked, maxK) {
  var out = [], seen = {};
  for (var i = 0; i < ranked.length && out.length < maxK; i++) {
    var m = ranked[i].move;
    var text = describeMove(s, role, Logic, m);
    if (seen[text]) continue;
    seen[text] = 1;
    out.push({ key: String.fromCharCode(97 + out.length), text: text, move: m, score: ranked[i].score });
  }
  return out;
}

module.exports = {
  INSTRUCTIONS: INSTRUCTIONS,
  SLOT_LABEL: SLOT_LABEL,
  describeState: describeState,
  describeMove: describeMove,
  renderOptions: renderOptions
};
