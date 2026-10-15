/* ============================================================
 * 天合小队 Sky Team —— AI 局面评估（合作视角）
 *
 * 机长与副驾目标一致（一起把飞机落下去），所以评估函数**不区分角色**，
 * 只需要区分「谁看得见什么」（见 ai/planner.js 的 fair 模式）。
 *
 * 返回值越大越好。终局 ±1e7，其余为启发式分。
 * 零依赖，Node / 浏览器通用。
 * ============================================================ */
'use strict';

var WIN_SCORE = 10000000;
var LOSE_SCORE = -10000000;

function evaluate(s, Logic, cfg) {
  if (s.phase === 'win') return WIN_SCORE;
  if (s.phase === 'lose') return LOSE_SCORE;
  if (!cfg) cfg = Logic.getScenarioConfig(s);

  var v = 0;

  /* ---- 1. 姿态：必须回到 0，任何时候都不能失衡 ---- */
  var a = Math.abs(s.axis);
  v -= a * 420;
  if (a >= 2) v -= 900 * (a - 1) * (a - 1);   // 越接近 ±3 越危险

  /* ---- 2. 进近进度 ---- */
  var stepsLeft = s.altitude / cfg.ALTITUDE_STEP;   // 还能自动下降几步
  var stepsDone = (cfg.ALTITUDE_START - s.altitude) / cfg.ALTITUDE_STEP;
  v += (cfg.DISTANCE_START - s.distance) * 320;
  // 每轮至少得推进一格，distance >= stepsLeft 时就已在悬崖边上
  if (s.distance >= stepsLeft) v -= (s.distance - stepsLeft + 1) * 1400;
  if (s.distance < 0) v -= 400000;                                    // 冲过机场

  /* ---- 3. 设备进度：与时间线对齐，越晚落后越致命 ---- */
  var total = Math.max(1, cfg.ROUNDS - 1);
  var expected = Math.min(1, stepsDone / total);
  var urgency = 1 + 1.5 * expected;
  v -= Math.max(0, expected * cfg.GEAR_COUNT - s.gearAct) * 300 * urgency;
  v -= Math.max(0, expected * cfg.FLAP_COUNT - s.flapsAct) * 300 * urgency;
  v -= Math.max(0, expected * cfg.BRAKE_COUNT - s.brakesAct) * 380 * urgency;
  // 绝对完成度也有价值（越早腾出手越好）
  v += s.gearAct * 60 + s.flapsAct * 60 + s.brakesAct * 80;

  /* ---- 3b. 容量硬检查：剩下的轮数还做得完设备吗 ----
   * 每轮每人 4 颗骰，其中 2 颗被姿态/引擎占用 → 非必填动作每轮上限 2 个。 */
  var roundsLeft = Math.max(0, stepsLeft);
  var pilotWork = (cfg.GEAR_COUNT - s.gearAct) + (cfg.BRAKE_COUNT - s.brakesAct);
  var copilotWork = (cfg.FLAP_COUNT - s.flapsAct);
  v -= Math.max(0, pilotWork - roundsLeft * 2) * 900;
  v -= Math.max(0, copilotWork - roundsLeft * 2) * 900;

  /* ---- 4. 交通 ---- */
  v -= s.traffic.length * 260;
  for (var i = 0; i < s.traffic.length; i++) {
    var d = s.traffic[i];
    if (d === s.distance) v -= 1200;        // 压在当前位置：下一步引擎推进即坠毁
    else if (d < s.distance) v -= 180;      // 挡在前方
  }

  /* ---- 5. 资源 ---- */
  v += s.coffee * 70 + s.reroll * 90;

  /* ---- 6. 着陆轮：引擎和必须严格小于刹车值 ---- */
  if (s.landingRound) {
    var pe = Logic.effVal(s.placements.pilot.engine);
    var ce = Logic.effVal(s.placements.copilot.engine);
    var lim = Logic.brakeValue(s);
    if (pe !== null && ce !== null) {
      v += (lim - (pe + ce)) * 900;
      if (pe + ce >= lim) v -= 200000;          // 已经确定摔了
    } else {
      var known = (pe !== null) ? pe : ce;      // 只放了一边：按另一边放 2 预估
      if (known !== null) v += (lim - (known + 2)) * 500;
    }
    // 着陆轮跑道必须清空（这一轮 radio 也只能打 distance 0，漏了就再也清不掉）
    v -= s.traffic.length * 3000;
  }

  return v;
}

var API = { evaluate: evaluate, WIN_SCORE: WIN_SCORE, LOSE_SCORE: LOSE_SCORE };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.SkyAIEvaluate = API;
