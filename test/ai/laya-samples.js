/* ============================================================
 * 抓「提示词真实样本」——从真实对局里挑出几类典型决策点，
 * 把喂给 laya 的 payload 原样落盘并打印。
 *
 * 与 ai/laya-client.js 构造 payload 的三行完全一致，
 * 不是手写的近似。
 *
 * 用法：node test/ai/laya-samples.js [局数]
 * 产出：test/ai/.samples-payload.json（供 test/ai/laya-samples.py 算 token 账本）
 * ============================================================ */
'use strict';

var path = require('path');
var fs = require('fs');
var http = require('http');
var ROOT = path.resolve(__dirname, '../..');

var { loadGameEnvironment } = require(path.join(ROOT, 'src/logic/load-logic'));
var Planner = require(path.join(ROOT, 'ai/planner'));
var Prompt = require(path.join(ROOT, 'ai/laya-prompt'));
var { GameLogic: Logic } = loadGameEnvironment(ROOT);

var N = parseInt(process.argv[2] || '300', 10);
var HOST = '127.0.0.1', PORT = 7788;

/* 按这些特征各取样本。
 * 优先要「真正有决策空间」的点：多件要事同时成立才是 laya 被问到的时候。
 * landing 额外要求合法落子多，才能看出选项膨胀的后果。 */
var buckets = [
  { tag: 'opening', want: function (s, act, ranked) { return s.round === 1 && act.length >= 2; } },
  { tag: 'rich', want: function (s, act, ranked) { return act.length >= 3 && !s.landingRound && ranked.length >= 20; } },
  { tag: 'coffee', want: function (s, act, ranked) { return s.coffee > 0 && s.round >= 3 && !s.landingRound && act.length >= 2; } },
  { tag: 'landing', want: function (s, act, ranked) { return !!s.landingRound && act.length >= 2 && ranked.length >= 35; } },
  { tag: 'single', want: function (s, act, ranked) { return act.length === 1 && !s.landingRound && s.round >= 2; } }
];

var found = {};

function buildPayload(s, role, cfg, active) {
  var options = Prompt.renderPriorities(s, role, Logic, cfg, active);
  return {
    state: Prompt.describeState(s, role, Logic),
    instructions: Prompt.instructionsFor(role, cfg.ROUNDS),
    options: options.map(function (o) { return { key: o.key, text: o.text }; })
  };
}

function post(body) {
  return new Promise(function (resolve) {
    var data = Buffer.from(JSON.stringify(body), 'utf8');
    var req = http.request({
      host: HOST, port: PORT, path: '/decide', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, function (res) {
      var c = [];
      res.on('data', function (x) { c.push(x); });
      res.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); }
        catch (e) { resolve({ error: 'bad json' }); }
      });
    });
    req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { resolve({ error: e.message }); });
    req.end(data);
  });
}

var samples = [];

for (var g = 0; g < N; g++) {
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
    var ranked = Planner.rankMoves(s, role, Logic, cfg, { fair: false, coop: 1 });
    if (!ranked.length) break;
    var active = Planner.activePriorities(ranked);

    for (var bi = 0; bi < buckets.length; bi++) {
      var b = buckets[bi];
      if (found[b.tag]) continue;
      if (!b.want(s, active, ranked)) continue;
      if (active.length < 2 && b.tag !== 'single') continue;
      found[b.tag] = true;
      var rec = {
        tag: b.tag,
        role: role,
        round: s.round,
        landing: !!s.landingRound,
        activeCount: active.length,
        legality: ranked.length,
        active: active.slice(),
        payload: buildPayload(s, role, cfg, active),
        plannerTop: Planner.ownPriority(ranked, Planner.bestMove(ranked, null, { fair: false, coop: 1 })),
        bestMoveScore: ranked[0].score
      };
      // 对照样本：同样局面，改成「直接选落子」。用来看 token 预算为什么撑不住。
      if (b.tag === 'rich') {
        var mvOpts = Prompt.renderOptions(s, role, Logic, ranked, 6);
        rec.moveLevel = {
          state: rec.payload.state,
          instructions: rec.payload.instructions,
          options: mvOpts.map(function (o) { return { key: o.key, text: o.text, score: o.score }; })
        };
      }
      // 极限推演的原料：这个局面的全部合法落子文本（按 renderOptions 的规则去重）
      if (b.tag === 'rich' || b.tag === 'landing') {
        var seenM = {}, texts = [];
        ranked.forEach(function (r) {
          var t = Prompt.describeMove(s, role, Logic, r.move);
          if (seenM[t]) return;
          seenM[t] = 1; texts.push(t);
        });
        rec.allMoves = texts;
      }
      samples.push(rec);
    }
    if (Object.keys(found).length === buckets.length) break;

    var mv = Planner.searchBestMove(s, role, Logic, cfg, { fair: false, coop: 1 });
    if (!mv) break;
    var r = Logic.placeDie(s, role, mv.dieIdx, mv.slot, { coffeePlus: mv.cp, coffeeMinus: mv.cm });
    if (!r || !r.ok) break;
  }
  if (Object.keys(found).length === buckets.length) break;
}

console.error('抓到 ' + samples.length + ' 个样本；用了 ' + (g + 1) + ' 局');

fs.writeFileSync(path.join(__dirname, '.samples-payload.json'),
  JSON.stringify(samples, null, 2));

/* ---------- 打印 + 真实调用 ---------- */
(async function () {
  var order = ['opening', 'rich', 'coffee', 'landing', 'single'];
  var n = 0;
  for (var i = 0; i < order.length; i++) {
    var sm = samples.filter(function (x) { return x.tag === order[i]; })[0];
    if (!sm) continue;
    n++;

    console.log('\n' + '━'.repeat(72));
    console.log('【样本 ' + n + '】' + sm.tag + '  —— ' +
      (sm.role === 'pilot' ? '机长' : '副驾') + '视角  第' + sm.round + '轮' +
      (sm.landing ? '（着陆轮）' : ''));
    console.log('   合法落子 ' + sm.legality + ' 个 → 归纳成 ' + sm.activeCount + ' 件要事' +
      '   规划器自己选：' + (sm.plannerTop || '(不属于任何命名要事)'));
    console.log('━'.repeat(72));

    if (sm.activeCount < 2) {
      console.log('▸ 只有 1 件要事成立 → 客户端的门控拦住，不发请求。');
      console.log('  （发了也只有一个选项，等于烧一次前向换零信息）');
      console.log('\n  state 仍然会渲染成这样：');
      console.log(sm.payload.state.split('\n').map(function (l) { return '  │ ' + l; }).join('\n'));
      continue;
    }

    console.log('▸ 真实发出去的 JSON（POST /decide）：');
    console.log(JSON.stringify(sm.payload, null, 2).split('\n').map(function (l) { return '  ' + l; }).join('\n'));

    var res = await post(sm.payload);
    console.log('\n▸ laya 返回：');
    if (res.error) {
      console.log('  ✗ ' + res.error);
    } else {
      var idx = 'abcdefgh'.indexOf(String(res.choice));
      var opt = sm.payload.options[idx] || {};
      var pickedId = sm.active[idx];
      console.log('  choice=' + res.choice + '   → ' + (opt.text || '?'));
      console.log('  probs ' + JSON.stringify(res.probs) +
        '   归一化熵置信 ' + (res.confidence != null ? Number(res.confidence).toFixed(3) : '-') +
        '   模型 ' + res.model + '   ' + res.ms + 'ms');
      console.log('  规划器自己选：' + (sm.plannerTop || '(无标签)') +
        '   → ' + (pickedId === sm.plannerTop ? '一致' : '不一致（laya 覆盖了规划器）'));
      if (opt.score != null) console.log('  注：规划器给该要事首选的分数 ' + Math.round(opt.score));
    }

    if (sm.moveLevel) {
      console.log('\n▸ 【对照】同一个局面，如果改成「直接选落子」会是什么样：');
      console.log('  选项从 ' + sm.payload.options.length + ' 个变成 ' +
        sm.moveLevel.options.length + ' 个：');
      sm.moveLevel.options.forEach(function (o) {
        console.log('    ' + o.key + '. ' + o.text);
      });
      console.log('  （规划器给这些落子的分数：' +
        sm.moveLevel.options.map(function (o) { return o.key + '=' + Math.round(o.score); }).join(' ') + '）');
      console.log('  （每个选项平分 token 预算，6 个已经接近 48/个的下限；' +
        '实际合法落子 ' + sm.legality + ' 个，写不下）');
    }
  }
  console.log('\n（payload 已落盘：test/ai/.samples-payload.json）');
})();
