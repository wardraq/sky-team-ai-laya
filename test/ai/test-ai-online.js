/* ============================================================
 * AI 陪玩 —— 联机冒烟测试
 *
 * 让机长与副驾两个座位都由 AI 托管，观战一整局，验证：
 *   1) 服务端能正确开启 AI 托管并自动开局
 *   2) AI 能按 phase 推进（掷骰 → 放置 → 结算 → 下一轮）
 *   3) 对局能走到 win / lose（不会卡死）
 *
 * 用法：
 *   PORT=8099 AI_DELAY=60 node server.js      # 另开一个终端
 *   node test/ai/test-ai-online.js                # 默认连 8099
 *   node test/ai/test-ai-online.js 5              # 连跑 5 局
 * ============================================================ */
'use strict';

const PORT = process.env.PORT || 8099;
const GAMES = +(process.argv[2] || 1);
const PER_GAME_TIMEOUT = 90000;

function playOne(idx) {
  return new Promise((resolve) => {
    const room = 'ai' + Date.now().toString(36) + idx;
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws?room=' + room + '&role=passenger&ai=both');
    const t0 = Date.now();
    let frames = 0, phases = [], finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch (e) {}
      resolve({ ok: false, why: '超时（phase=' + (phases[phases.length - 1] || '?') + '）', frames, phases, ms: Date.now() - t0 });
    }, PER_GAME_TIMEOUT);

    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      resolve(Object.assign({ frames, phases, ms: Date.now() - t0 }, r));
    };

    ws.onerror = () => finish({ ok: false, why: 'WebSocket 连接失败（服务器起了吗？）' });
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== 'state') return;
      const s = m.state;
      frames++;
      if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
      if (s.phase === 'win' || s.phase === 'lose') {
        finish({
          ok: true, win: s.phase === 'win', rounds: s.round,
          reason: s.loseReason || '',
          axis: s.axis, gear: s.gearAct, flaps: s.flapsAct, brakes: s.brakesAct,
          traffic: s.traffic.length, distance: s.distance
        });
      }
    };
  });
}

(async function main() {
  console.log('=== AI 陪玩联机测试（端口 ' + PORT + '，' + GAMES + ' 局）===');
  let wins = 0;
  for (let i = 0; i < GAMES; i++) {
    const r = await playOne(i);
    if (!r.ok) {
      console.log('局 ' + (i + 1) + '：✗ ' + r.why);
      continue;
    }
    if (r.win) wins++;
    console.log('局 ' + (i + 1) + '：' + (r.win ? '🏆 降落成功' : '💥 坠毁') +
      '  轮数 ' + r.rounds + '  状态帧 ' + r.frames + '  耗时 ' + (r.ms / 1000).toFixed(1) + 's');
    console.log('     phase 轨迹: ' + r.phases.join(' → '));
    if (!r.win) console.log('     原因: ' + r.reason);
    console.log('     终局: 姿态' + r.axis + ' 起落架' + r.gear + '/3 襟翼' + r.flaps + '/4 刹车' + r.brakes + '/3' +
      ' 剩余交通 ' + r.traffic + ' 距机场 ' + r.distance);
  }
  console.log('\n胜率 ' + wins + '/' + GAMES);
  process.exit(0);
})();
