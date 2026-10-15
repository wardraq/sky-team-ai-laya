/* ============================================================
 * 天合小队 Sky Team —— AI 玩家适配层
 *
 * 把 ai/planner.js 的决策接到服务端：
 *   - 默认走确定性规划器（零依赖，~30ms/步）
 *   - 可选外接 laya 决策服务（ai/laya-client.js），拿不到就自动降级
 *
 * 对外：createAIPlayer(Logic, opts).decide(state, role) -> Promise<{name,args}|null>
 * ============================================================ */
'use strict';

var Planner = require('./planner');

var LayaClient = null;
try { LayaClient = require('./laya-client'); } catch (e) { LayaClient = null; }

function createAIPlayer(Logic, opts) {
  opts = opts || {};
  var engine = opts.engine || 'planner';        // 'planner' | 'laya' | 'auto'
  var fair = opts.fair === true;                // 默认全知：与当前「放置阶段公开」的规则一致
  var coop = (opts.coop == null) ? 1 : opts.coop;
  var layaOpts = opts.laya || {};

  function decideSync(s, role) {
    return Planner.decide(s, role, Logic, { fair: fair, coop: coop, samples: opts.samples });
  }

  function decide(s, role) {
    var useLaya = (engine === 'laya' || engine === 'auto') && LayaClient;
    if (!useLaya) return Promise.resolve(decideSync(s, role));

    return LayaClient.decide(Logic, s, role, layaOpts)
      .then(function (act) {
        // laya 只在 place 阶段介入；其它 phase 仍走确定性流程
        if (act) return { name: 'place', args: [act.dieIdx, act.slot, act.cp || 0, act.cm || 0] };
        return decideSync(s, role);
      })
      .catch(function () { return decideSync(s, role); });   // 服务挂了就降级
  }

  return {
    decide: decide,
    decideSync: decideSync,
    engine: engine,
    fair: fair,
    layaAvailable: !!LayaClient
  };
}

module.exports = { createAIPlayer: createAIPlayer };
