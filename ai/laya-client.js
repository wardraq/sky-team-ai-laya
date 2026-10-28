/* ============================================================
 * 天合小队 Sky Team —— laya 客户端（Node 侧，零依赖）
 *
 * 分工：
 *   planner  负责「算」—— 枚举、前瞻、给落子标上它实现的要事
 *   laya     负责「选要事」—— 只在两件以上同时成立时挑一件
 *
 * 落子仍由规划器在选中的要事里取最高分。要事不足两件、服务不可用、
 * 或调用方还在旁路阶段时，不改规划器的落子。
 * ============================================================ */
'use strict';

var http = require('http');
var Planner = require('./planner');
var Prompt = require('./laya-prompt');

var HOST = process.env.LAYA_HOST || '127.0.0.1';
var PORT = +(process.env.LAYA_PORT || 7788);
var TIMEOUT = +(process.env.LAYA_TIMEOUT || 8000);
var COOLDOWN = +(process.env.LAYA_COOLDOWN || 30000);

// 服务没起来时不要每一步都空跑一次 HTTP：连续失败后熔断一段时间
var _failUntil = 0;
function tripped() { return Date.now() < _failUntil; }
function trip() { _failUntil = Date.now() + COOLDOWN; }

function post(path, body) {
  return new Promise(function (resolve, reject) {
    var data = Buffer.from(JSON.stringify(body), 'utf8');
    var req = http.request({
      host: HOST, port: PORT, path: path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('laya 返回的不是 JSON')); }
      });
    });
    req.setTimeout(TIMEOUT, function () { req.destroy(new Error('laya 请求超时')); });
    req.on('error', reject);
    req.end(data);
  });
}

/** 探活：服务没起来就别浪费一次决策时间 */
function health() {
  return new Promise(function (resolve) {
    var req = http.get({ host: HOST, port: PORT, path: '/health' }, function (res) {
      var b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false }); }
      });
    });
    req.setTimeout(1500, function () { req.destroy(); resolve({ ok: false }); });
    req.on('error', function () { resolve({ ok: false }); });
  });
}

/**
 * 把「语义上成立的要事」收敛成「真的构成选择题的要事」。
 *
 * activePriorities 是按标签计数的，于是会出现两件要事其实指向同一批落子
 * （match_axis 与 fill_mandatory 常常重合），或者某件要事背后只有一两个落子
 * —— 那时无论选哪件，规划器都只能走出同一个动作，等于问了道没有答案的题。
 *
 * 实测：修饰前 120 个「被问到」的局面里，80% 属于这类假题。
 * 剔除它们符合既有原则 —— 没有真实不确定性时，不要调用判定引擎。
 */
function usablePriorities(ranked, active) {
  var map = {}, i, j, k;
  for (i = 0; i < active.length; i++) map[active[i]] = [];
  for (j = 0; j < ranked.length; j++) {
    var ps = ranked[j].priorities || [];
    for (k = 0; k < ps.length; k++) {
      if (map[ps[k]]) map[ps[k]].push(j);
    }
  }
  var seen = {}, out = [];
  for (i = 0; i < active.length; i++) {
    var id = active[i], keys = map[id];
    if (keys.length < 2) continue;      // 背后不足两个落子 → 选谁都一样
    var sig = keys.join(',');
    if (seen[sig]) continue;            // 与前面的要事是同一批落子 → 重复出题
    seen[sig] = 1;
    out.push(id);
  }
  return out;
}

/**
 * 让 laya 在当前成立的要事里挑一件。
 * 不足两件、或服务在熔断中：不发请求，choice 为 null。
 * @returns {Promise<{ranked,active,own,asked,choice,confidence}|null>}
 */
function choosePriority(Logic, s, role, opts) {
  opts = opts || {};
  if (!s || s.phase !== 'place' || s.currentPlayer !== role) return Promise.resolve(null);

  var cfg = Logic.getScenarioConfig(s);
  var ranked = Planner.rankMoves(s, role, Logic, cfg, opts);
  var activeAll = Planner.activePriorities(ranked);
  var active = opts.rawQuestions ? activeAll : usablePriorities(ranked, activeAll);
  var info = {
    ranked: ranked,
    active: active,
    activeAll: activeAll,
    own: null,
    asked: false,
    choice: null,
    confidence: 0
  };
  info.own = Planner.ownPriority(ranked, Planner.bestMove(ranked, null, opts));
  if (active.length < 2 || tripped()) return Promise.resolve(info);

  var options = Prompt.renderPriorities(s, role, Logic, cfg, active);
  if (options.length < 2) return Promise.resolve(info);

  var payload = {
    state: Prompt.describeState(s, role, Logic),
    instructions: Prompt.instructionsFor(role, cfg.ROUNDS),
    options: options.map(function (o) { return { key: o.key, text: o.text }; })
  };

  return post('/decide', payload).then(function (res) {
    info.asked = true;
    if (!res || res.error || !res.choice) return info;
    var hit = null;
    for (var i = 0; i < options.length; i++) {
      if (options[i].key === res.choice) { hit = options[i]; break; }
    }
    if (!hit) return info;
    info.choice = hit.id;
    info.confidence = (typeof res.confidence === 'number') ? res.confidence : 0;
    if (opts.verbose) {
      console.log('[laya] 要事 ' + info.choice + '  conf=' + info.confidence +
        '  model=' + res.model + '  ' + res.ms + 'ms');
    }
    return info;
  }).catch(function (e) {
    trip();
    info.asked = true;
    if (opts.verbose) console.warn('[laya] 不可用，已降级：' + (e && e.message));
    return info;
  });
}

module.exports = {
  choosePriority: choosePriority,
  usablePriorities: usablePriorities,
  health: health,
  HOST: HOST,
  PORT: PORT
};
