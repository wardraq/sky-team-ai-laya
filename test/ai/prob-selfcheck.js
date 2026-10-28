'use strict';
var P = require('../../ai/prob');

function show(name, v) {
  console.log(name + '  ' + v);
}

show('水平放 4，4 颗未知', P.axisCrashProb(0, 'copilot', 4, 4, null, false));
show('水平放 1，4 颗未知', P.axisCrashProb(0, 'copilot', 1, 4, null, false));
show('水平放 4，对方有 2', P.axisCrashProb(0, 'copilot', 4, 4, [2, 2, 3, 5], false));
show('水平放 4，对方全是 1', P.axisCrashProb(0, 'copilot', 4, 4, [1, 1, 1, 1], false));
show('最合适水平', P.bestAxisValue(0, 'copilot', null, false));
show('最合适 -1', P.bestAxisValue(-1, 'copilot', null, false));

var early = { altitude: 6000, distance: 6, blueMark: 5, orangeMark: 8, traffic: [], dice: { pilot: [], copilot: [] } };
var late = { altitude: 2000, distance: 2, blueMark: 5, orangeMark: 12, traffic: [], dice: { pilot: [], copilot: [] } };
var cfg = { ALTITUDE_STEP: 1000 };
show('开局走 1', P.stepRisk(early, 1, cfg));
show('开局走 2', P.stepRisk(early, 2, cfg));
show('开局目标', P.bestStep(early, cfg));
show('持平且橙 12 走 0', P.stepRisk(late, 0, cfg));
show('持平且橙 12 走 1', P.stepRisk(late, 1, cfg));
show('持平且橙 12 走 2', P.stepRisk(late, 2, cfg));
show('持平目标', P.bestStep(late, cfg));

var blocked = {
  altitude: 6000, distance: 6, blueMark: 5, orangeMark: 8,
  traffic: [5],
  dice: { pilot: [{ v: 6, used: false }, { v: 6, used: false }, { v: 6, used: false }, { v: 6, used: false }], copilot: [{ v: 6, used: false }, { v: 6, used: false }, { v: 6, used: false }, { v: 6, used: false }] }
};
show('前一格有飞机且清不掉，走 2', P.stepRisk(blocked, 2, cfg));
show('前一格有飞机且清不掉，走 1', P.stepRisk(blocked, 1, cfg));
show('前一格目标', P.bestStep(blocked, cfg));
