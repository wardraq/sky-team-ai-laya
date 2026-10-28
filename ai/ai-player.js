/* ============================================================
 * 天合小队 Sky Team —— AI 玩家适配层
 *
 * 把 ai/planner.js 的决策接到服务端：
 *   - 默认走规划器。姿态和引擎按坠毁概率选，本回合做成的操作另加分（opts.prob 默认开）
 *   - 分数接近的要事会用终局胜负再选一次（opts.macro 默认开）
 *   - engine=laya 时，放置阶段把成立的要事交给 laya 选
 *   - 默认旁路：落子仍用规划器。layaApply 打开后，置信度够才改用 laya 的要事
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
  var layaApply = opts.layaApply === true;      // 默认旁路，不让 laya 改落子
  var layaMinConf = (opts.layaMinConf == null) ? 0.6 : opts.layaMinConf;
  var macro = opts.macro !== false;
  var prob = opts.prob !== false;
  var searchOpts = { fair: fair, coop: coop, samples: opts.samples, macro: macro, prob: prob };
  var stats = { asked: 0, agree: 0 };

  function decideSync(s, role) {
    return Planner.decide(s, role, Logic, searchOpts);
  }

  function placeFrom(move) {
    if (!move) return null;
    return { name: 'place', args: [move.dieIdx, move.slot, move.cp || 0, move.cm || 0] };
  }

  /** 旁路时用规划器落子；layaApply 且置信度达到阈值时，改用 laya 选中的要事 */
  function resolvePlace(info) {
    var plannerMove = Planner.bestMove(info.ranked, null, searchOpts);
    var own = Planner.ownPriority(info.ranked, plannerMove);
    var choice = info.choice || null;
    var conf = info.confidence || 0;
    if (info.asked && choice) {
      stats.asked++;
      if (choice === own) stats.agree++;
      var rate = (stats.agree / stats.asked * 100).toFixed(0);
      console.log('[laya] 要事 规划器=' + (own || '无') + ' laya=' + choice +
        ' 一致=' + (choice === own ? '1' : '0') +
        ' conf=' + conf +
        ' 累计 ' + stats.agree + '/' + stats.asked + ' (' + rate + '%)');
    }
    if (layaApply && choice && conf >= layaMinConf) {
      var alt = Planner.bestMove(info.ranked, choice, searchOpts);
      if (alt) return { move: alt, applied: true, own: own, choice: choice };
    }
    return { move: plannerMove, applied: false, own: own, choice: choice };
  }

  function decide(s, role) {
    var useLaya = (engine === 'laya' || engine === 'auto') && LayaClient;
    if (!useLaya || !s || s.phase !== 'place' || s.currentPlayer !== role) {
      return Promise.resolve(decideSync(s, role));
    }

    return LayaClient.choosePriority(Logic, s, role, searchOpts)
      .then(function (info) {
        if (!info || !info.ranked) return decideSync(s, role);
        var picked = resolvePlace(info);
        if (picked.applied && picked.move) return placeFrom(picked.move);
        if (searchOpts.macro) return decideSync(s, role);
        return placeFrom(picked.move) || decideSync(s, role);
      })
      .catch(function () { return decideSync(s, role); });
  }

  return {
    decide: decide,
    decideSync: decideSync,
    engine: engine,
    fair: fair,
    layaApply: layaApply,
    layaMinConf: layaMinConf,
    layaAvailable: !!LayaClient,
    macro: macro,
    prob: prob,
    resolvePlace: resolvePlace,
    stats: stats
  };
}

module.exports = { createAIPlayer: createAIPlayer };
