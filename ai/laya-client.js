/* ============================================================
 * 天合小队 Sky Team —— laya 客户端（Node 侧，零依赖）
 *
 * 分工：
 *   planner.rankMoves()  负责「算」—— 枚举 + 前瞻，给出 Top-K 候选
 *   laya                 负责「挑」—— 在候选里选一个它认为最好的
 *
 * 为什么不是让 laya 直接算棋：
 *   laya 是 421M 的判定引擎，没有搜索能力。实测确认「laya 能替代评分，
 *   不能替代搜索」。所以位置是「候选排序器」，输入严格控制在 6~8 个选项。
 *
 * 失败一律返回 null，交给上层降级到确定性规划器 —— AI 不会因为
 * laya 没起来就停摆。
 * ============================================================ */
'use strict';

var http = require('http');
var Planner = require('./planner');
var Prompt = require('./laya-prompt');

var HOST = process.env.LAYA_HOST || '127.0.0.1';
var PORT = +(process.env.LAYA_PORT || 7788);
var TIMEOUT = +(process.env.LAYA_TIMEOUT || 8000);
var DEFAULT_K = +(process.env.LAYA_MAX_OPTIONS || 6);
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
 * 让 laya 在 Top-K 候选里挑一个。
 * @returns {Promise<{dieIdx,slot,cp,cm}|null>} null → 上层走确定性规划器
 */
function decide(Logic, s, role, opts) {
  opts = opts || {};
  if (!s || s.phase !== 'place' || s.currentPlayer !== role) return Promise.resolve(null);
  if (tripped()) return Promise.resolve(null);

  var cfg = Logic.getScenarioConfig(s);
  var ranked = Planner.rankMoves(s, role, Logic, cfg, opts);
  if (ranked.length <= 1) return Promise.resolve(ranked.length ? ranked[0].move : null);

  // 候选本身也要过滤：完全等价的走法只留一个分数最高的
  var minGap = (opts.minGap != null) ? opts.minGap : 0;
  if (minGap > 0) {
    ranked = ranked.filter(function (r) { return ranked[0].score - r.score <= minGap; });
  }

  var options = Prompt.renderOptions(s, role, Logic, ranked, (opts.maxOptions || DEFAULT_K));
  if (options.length <= 1) return Promise.resolve(options.length ? options[0].move : null);

  var payload = {
    state: Prompt.describeState(s, role, Logic),
    instructions: Prompt.INSTRUCTIONS,
    options: options.map(function (o) { return { key: o.key, text: o.text }; })
  };

  return post('/decide', payload).then(function (res) {
    if (!res || res.error || !res.choice) return null;
    var hit = null;
    for (var i = 0; i < options.length; i++) {
      if (options[i].key === res.choice) { hit = options[i]; break; }
    }
    if (!hit) return null;
    if (opts.verbose) {
      console.log('[laya] 选 ' + res.choice + ' (' + hit.text + ')  conf=' +
        res.confidence + '  model=' + res.model + '  ' + res.ms + 'ms');
    }
    return hit.move;
  }).catch(function (e) {
    // 服务不可用 → 熔断，这局之后的每一步都直接走确定性规划器
    trip();
    if (opts.verbose) console.warn('[laya] 不可用，已降级：' + (e && e.message));
    return null;
  });
}

module.exports = { decide: decide, health: health, HOST: HOST, PORT: PORT };
