/**
 * engine.js — Máy trạng thái Martingale Extension Dashboard (CONTRACT §MartingaleEngine).
 *
 * LUỒNG TRẠNG THÁI:
 *
 *   IDLE ──startNew()──▶ RUNNING ◀──resume()── PAUSED ──pause()──┐
 *                          │                    (giữ nguyên phiên     │
 *                          │                     + thống kê)◀─────────┘
 *          notifyBlocked() │ │ notifyUnblocked()
 *                          ▼ │
 *                       BLOCKED ── (wasRunningBeforeBlock = đang RUNNING mà bị chặn)
 *
 *   RUNNING ──shouldStop() đúng──▶ ENDED (bảng tổng kết; "Bắt đầu" sau đó = phiên mới)
 *
 *   tick() khi RUNNING: !orderPlaced && !blocked && UI sẵn sàng
 *     → MartingaleStats.nextLevel() → MartingaleRNG.pickSide() ('T'|'CT', KHÔNG BAO GIỜ DICE)
 *     → MartingaleDOM.placeOrder() → chờ kết quả → recordRound + push điểm chart + save
 *     → thắng về baseLevel, thua x2 (martingale, không cap số lần x2).
 *
 *   Mọi biến trạng thái đều được MartingaleStorage.save() NGAY (sống sót reload,
 *   kể cả reload do Cloudflare). Khi đặt lệnh, session.pendingOrder giữ
 *   {
   *   {side, order, t, lastCount, fp} để vòng dang dở được đối soát sau reload
 *   mà không ghi trùng vòng (lastCount = số vòng đã chốt lúc đặt lệnh,
 *   fp = dấu vân tay danh sách kết quả lúc đặt lệnh).
 *
 *   GHI CHÚ TÍCH HỢP (NOTE Agent-D, dom.js + cf-watch.js đã xong):
 *    - Tiền: dom.js đã quy đổi hiển thị site (coin/100) ×100; engine tính toán
 *      với số tiền 2 chữ số thập phân (round2) — site cho lệnh lẻ 0.01.
 *    - placeOrder(side, amount) reject với reason: DICE_BLOCKED / INVALID_SIDE /
 *      INVALID_AMOUNT / UI_NOT_READY / INPUT_SET_FAILED / BUTTON_DISABLED /
 *      CLICK_FAILED — tick() xử lý có chủ đích, không retry mù.
 *    - MartingaleCF.checkNow() được gọi xác nhận lại ngay TRƯỚC MỖI lệnh.
 *    - isUiReady(): ô nhập lệnh + nút T + nút CT đều isConnected.
 *    - Chống đọc trùng: getResults(1) luôn trả vòng MỚI NHẤT nên engine so
 *      dấu vân tay danh sách kết quả (top 3) với lúc đặt lệnh và đối chiếu
 *      số vòng đã ghi trong session.history — không ghi 2 vòng cùng index.
 *
 *   restoreAfterReload(): load storage; nếu RUNNING/BLOCKED → chờ tối đa 120s
 *   tới khi MartingaleDOM.isUiReady() && !MartingaleCF.isBlocked() rồi chạy tiếp;
 *   quá 120s → PAUSED kèm lý do (người dùng bấm "Tiếp tục" khi sẵn sàng).
 *
 *   Kết quả 'DICE' đọc từ trang được tính là THUA cho lệnh T/CT.
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  // ---- hằng số vận hành ----
  var POLL_RESULT_MS = 1500;      // chu kỳ hỏi kết quả sau khi đặt lệnh
  var RESULT_TIMEOUT_MS = 120000; // chờ kết quả tối đa 120s
  var MIN_RESULT_DELAY_MS = 3000; // không nhận kết quả trước 3s kể từ lúc lệnh
  var RESULT_SOFT_TIMEOUT_MS = 25000; // không thấy dịch chuyển → đối soát bằng biến thiên số dư
  var RESTORE_TIMEOUT_MS = 120000;// chờ UI sẵn sàng sau reload tối đa 120s
  var RESTORE_POLL_MS = 1000;     // chu kỳ kiểm tra UI khi restore
  var MAX_CHART_POINTS = 10000;   // trần điểm chart (chống phình storage)
  var MAX_HISTORY = 10000;        // trần dòng lịch sử

  var session = null;      // phiên hiện tại (schema MartingaleStorage)
  var summary = null;      // bản tổng kết mới nhất (đọc qua getSummary)
  var busy = false;
  var stopToken = 0; // tăng khi reset: mọi thao tác async cũ bị vô hiệu        // cờ chống re-entry cho tick()
  var liveBalance = null;  // số dư nhập tay/DOM mới nhất (setLiveBalance)
  var listeners = [];      // callback onChange

  // ---- truy cập module (chấp nhận vắng mặt khi mock từng phần) ----
  function dom() { return root.MartingaleDOM || null; }
  function cf() { return root.MartingaleCF || null; }
  function storage() { return root.MartingaleStorage || null; }
  function stats() { return root.MartingaleStats || null; }
  function rng() { return root.MartingaleRNG || null; }

  function log() {
    try {
      var args = ['[MartingaleEngine]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    } catch (e) { /* im lặng */ }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** Làm tròn tiền 2 chữ số thập phân (site cho lệnh lẻ 0.01). */
  function round2(x) {
    return Math.round(Number(x) * 100) / 100;
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](session ? session.phase : 'IDLE', session); } catch (e) { /* bỏ qua */ }
    }
  }

  /** Đăng ký callback(phase, session) — trả về hàm hủy đăng ký. */
  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
    return function () {
      var idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  /** Lưu session NGAY sau mỗi biến trạng thái. */
  async function persist() {
    var st = storage();
    if (!st || !session) return;
    try { await st.save(session); } catch (e) { log('Lỗi lưu storage:', e && e.message); }
  }

  function freshSession() {
    var st = storage();
    if (st && typeof st.defaultSession === 'function') return st.defaultSession();
    return {
      baseLevel: 100, phase: 'IDLE', wasRunningBeforeBlock: false,
      baseBalance: null, currentLevel: null, orderPlaced: false,
      rounds: 0, wins: 0, losses: 0, currentLossStreak: 0, maxLossStreak: 0,
      profit: 0, history: [], chart: []
    };
  }

  function newestResult() {
    var d = dom();
    if (!d || typeof d.getResults !== 'function') return null;
    try {
      var arr = d.getResults(1);
      return (arr && arr.length ? arr[0] : null) || null;
    } catch (e) { return null; }
  }

  /** Số vòng đã chốt trong phiên — đối chiếu session.history (NOTE Agent-D #1). */
  function countRounds() {
    return (session && Array.isArray(session.history)) ? session.history.length : 0;
  }

  /** Dấu vân tay top-n kết quả mới nhất (mới nhất đầu) để phát hiện dịch chuyển. */
  function resultsFingerprint(n) {
    var d = dom();
    if (!d || typeof d.getResults !== 'function') return '';
    try {
      var arr = d.getResults(n) || [];
      return arr.join('|');
    } catch (e) { return ''; }
  }

  function buildSummary(reason) {
    var s = session || {};
    var st = stats();
    var finalBal = (typeof liveBalance === 'number' && isFinite(liveBalance))
      ? liveBalance
      : ((st && typeof st.lastBalance === 'function')
        ? st.lastBalance(s)
        : (typeof s.baseBalance === 'number' ? s.baseBalance : null));
    return {
      endedAt: s.endedAt || Date.now(),
      reason: reason || s.stopReason || null,
      baseBalance: typeof s.baseBalance === 'number' ? s.baseBalance : null,
      finalBalance: finalBal,
      rounds: s.rounds || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      maxLossStreak: s.maxLossStreak || 0,
      profit: s.profit || 0
    };
  }

  // ---- bắt đầu phiên mới ----
  function startNew(baseLevel, baseBalance) {
    stopToken = (stopToken || 0) + 1; // Start mới vô hiệu mọi tick/waitForResult của phiên cũ còn treo
    var bb = Math.max(0.01, round2(Number(baseLevel)) || 0.01);
    var base = (baseBalance == null) ? NaN : Number(baseBalance); // null/undefined → đọc DOM
    if (!isFinite(base)) {
      var d = dom();
      var b = (d && typeof d.getBalance === 'function') ? d.getBalance() : null;
      base = (typeof b === 'number' && isFinite(b)) ? round2(b) : null;
    } else {
      base = round2(base);
    }
    session = freshSession();
    session.baseLevel = bb;
    session.baseBalance = base;
    session.phase = 'RUNNING';
    session.orderPlaced = false;
    session.pendingOrder = null;
    summary = null;
    log('Phiên mới — lệnh gốc', bb, '| mốc gốc', base);
    persist();
    notify();
    return session;
  }

  // ---- tạm dừng / tiếp tục (giữ nguyên phiên) ----
  function pause() {
    if (!session || session.phase !== 'RUNNING') return session;
    session.phase = 'PAUSED';
    session.pauseReason = 'Tạm dừng bởi người dùng.';
    log('PAUSED — giữ phiên,', session.rounds, 'vòng đã chơi');
    persist();
    notify();
    return session;
  }

  function resume() {
    if (!session || session.phase !== 'PAUSED') return session;
    session.phase = 'RUNNING';
    session.pauseReason = null;
    log('Tiếp tục RUNNING');
    persist();
    notify();
    return session;
  }

  // ---- Cloudflare chặn / hết chặn ----
  function notifyBlocked() {
    if (!session) return;
    if (session.phase === 'RUNNING') {
      session.phase = 'BLOCKED';
      session.wasRunningBeforeBlock = true;
      log('BLOCKED — Cloudflare, phiên sẽ tự tiếp tục khi hết chặn');
      persist();
      notify();
    }
  }

  function notifyUnblocked() {
    if (!session || session.phase !== 'BLOCKED') return;
    if (session.wasRunningBeforeBlock) {
      session.phase = 'RUNNING';
      session.wasRunningBeforeBlock = false;
      log('Hết chặn — quay lại RUNNING');
    } else {
      // Trước lúc chặn không phải RUNNING: về PAUSED nếu đã vào phiên, ngược lại IDLE.
      session.phase = (session.rounds > 0 || session.orderPlaced) ? 'PAUSED' : 'IDLE';
      log('Hết chặn — không có phiên đang chạy, về', session.phase);
    }
    persist();
    notify();
  }

  // ---- kết thúc phiên + tổng kết ----
  function endSession(reason) {
    if (!session) return;
    session.phase = 'ENDED';
    session.endedAt = Date.now();
    session.stopReason = reason || session.stopReason || null;
    summary = buildSummary(session.stopReason);
    log('KẾT THÚC PHIÊN:', session.stopReason);
    persist();
    notify();
  }

  // ---- chờ kết quả vòng đang lệnh ----
  // Chống đọc trùng (NOTE Agent-D #1): getResults luôn trả vòng mới nhất nên
  // KHÔNG so từng kết quả đơn lẻ. Ta so dấu vân tay top-3 kết quả
  // (resultsFingerprint) với lúc đặt lệnh: chỉ chấp nhận khi danh sách ĐÃ DỊCH
  // chuyển (có vòng mới đổ về đầu) và đã qua MIN_RESULT_DELAY_MS kể từ lúc
  // lệnh, kết hợp lastCount (session.history.length lúc đặt lệnh) để không
  // bao giờ ghi 2 vòng cùng index.
  // BLOCKED giữa chừng → aborted (giữ pending, đối soát sau khi hết chặn).
  /** Ghi chú trạng thái cho hàng "Ghi chú" trên dashboard — chỉ ghi + lưu khi THAY ĐỔI. */
  function setNote(txt) {
    if (!session || session.note === txt) return;
    session.note = txt;
    persist();
  }

  function waitForResult(pending) {
    return new Promise(function (resolve) {
      var baseline = pending.fp || '';
      function step() {
        if (!session || session.phase !== 'RUNNING') { resolve({ aborted: true, reason: 'RESET' }); return; }
        var c = cf();
        if (c && typeof c.isBlocked === 'function' && c.isBlocked()) {
          resolve({ aborted: true, reason: 'BLOCKED' });
          return;
        }
        var head = newestResult();
        var fp = resultsFingerprint(3);
        if (!baseline && fp) {
          // Không chụp được dấu vân tay lúc đặt lệnh (trang chưa render):
          // nhận trạng thái hiện tại làm baseline ở lần hỏi đầu tiên.
          baseline = fp;
        }
        var shifted = !!head && !!baseline && fp !== baseline;
        var elapsed = Date.now() - (pending.t || Date.now());
        if (shifted && elapsed >= MIN_RESULT_DELAY_MS) {
          resolve({ aborted: false, result: head, timeout: false });
          return;
        }
        if (elapsed >= RESULT_SOFT_TIMEOUT_MS && pending.bal0 != null) {
          var dSoft = dom();
          var balSoft = (dSoft && typeof dSoft.getBalance === 'function') ? dSoft.getBalance() : null;
          if (typeof balSoft !== 'number' || !isFinite(balSoft)) balSoft = liveBalance;
          if (typeof balSoft === 'number' && isFinite(balSoft)) {
            var deltaSoft = Math.round((balSoft - pending.bal0) * 100) / 100;
            if (Math.abs(deltaSoft - pending.order) < 0.005) { resolve({ aborted: false, result: pending.side, soft: true }); return; }
            if (Math.abs(deltaSoft + pending.order) < 0.005) { resolve({ aborted: false, result: (pending.side === 'T' ? 'CT' : 'T'), soft: true }); return; }
          }
          setNote('Không thấy kết quả trên trang — đối soát bằng biến thiên số dư…');
        }
        if (elapsed >= RESULT_TIMEOUT_MS) {
          if (shifted) {
            // Trang vừa reload: kết quả của vòng ta đã nằm trong danh sách.
            resolve({ aborted: false, result: head, timeout: true });
          } else {
            // Không có vòng mới nào đổ về — CHỐT KHÔNG ghi để tránh trùng index.
            resolve({ aborted: true, reason: 'TIMEOUT' });
          }
          return;
        }
        setTimeout(step, POLL_RESULT_MS);
      }
      setTimeout(step, POLL_RESULT_MS);
    });
  }

  // ---- chốt một vòng: record + chart + save + kiểm tra mốc dừng ----
  async function finishRound(result, pending) {
    if (!session) return;
    var win = result === pending.side; // 'DICE' không bao giờ bằng 'T'/'CT' → THUA
    var d = dom();
    var domBal = (d && typeof d.getBalance === 'function') ? d.getBalance() : null;
    var bal;
    if (typeof domBal === 'number' && isFinite(domBal)) {
      bal = round2(domBal);
    } else {
      var st = stats();
      var prev = (st && typeof st.lastBalance === 'function')
        ? st.lastBalance(session)
        : (typeof session.baseBalance === 'number' ? session.baseBalance : 0);
      bal = prev + (win ? pending.order : -pending.order);
    }
    var payout = win ? pending.order : -pending.order; // lãi/lỗ ròng của vòng

    var s = stats();
    if (s && typeof s.recordRound === 'function') {
      s.recordRound(session, {
        order: pending.order, side: pending.side, result: result,
        payout: payout, balance: bal
      });
    } else {
      // fallback tối thiểu nếu stats.js chưa nạp (không bao giờ xảy ra theo manifest)
      session.rounds = (session.rounds || 0) + 1;
      if (win) {
        session.wins = (session.wins || 0) + 1;
        session.currentLossStreak = 0;
      } else {
        session.losses = (session.losses || 0) + 1;
        session.currentLossStreak = (session.currentLossStreak || 0) + 1;
        if (session.currentLossStreak > (session.maxLossStreak || 0)) {
          session.maxLossStreak = session.currentLossStreak;
        }
      }
      session.profit = (session.profit || 0) + payout;
      if (!Array.isArray(session.history)) session.history = [];
      session.history.push({
        t: Date.now(), order: pending.order, side: pending.side,
        result: result, payout: payout, balance: bal,
        streakAfter: session.currentLossStreak
      });
    }

    if (!Array.isArray(session.chart)) session.chart = [];
    session.chart.push({ t: Date.now(), balance: bal });
    if (session.chart.length > MAX_CHART_POINTS) {
      session.chart.splice(0, session.chart.length - MAX_CHART_POINTS);
    }
    if (Array.isArray(session.history) && session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }

    session.currentLevel = pending.order; // giữ lại để nextLevel() x2 khi thua
    session.orderPlaced = false;
    session.pendingOrder = null;
    log('Vòng', session.rounds, '|', pending.side, '→', result,
      win ? 'THẮNG' : 'THUA', '| balance', bal);
    await persist();
    notify();

    // Mốc dừng: ≤30% mốc gốc, hoặc không đủ tiền cho vòng kế tiếp.
    var s2 = stats();
    var chk = (s2 && typeof s2.shouldStop === 'function')
      ? s2.shouldStop(session, (typeof domBal === 'number' && isFinite(domBal)) ? domBal : liveBalance)
      : { stop: false, reason: null };
    if (chk && chk.stop) endSession(chk.reason);
  }

  // ---- đặt lệnh vòng mới ----
  async function placeNewBet() {
    if (!session) return;
    // NOTE Agent-D #3: xác nhận lại trạng thái Cloudflare NGAY TRƯỚC lệnh.
    var cf0 = cf();
    if (cf0 && typeof cf0.checkNow === 'function') {
      try {
        if (cf0.checkNow()) { log('checkNow: đang bị chặn — hoãn lệnh'); return; }
      } catch (e0) { /* bỏ qua lỗi checkNow */ }
    }
    var r = rng();
    if (!r || typeof r.pickSide !== 'function') {
      log('Thiếu MartingaleRNG — không đặt lệnh mù;');
      return;
    }
    var s = stats();
    var order = (s && typeof s.nextLevel === 'function')
      ? s.nextLevel(session)
      : Math.max(0.01, round2(Number(session.baseLevel)) || 0.01);
    var side = r.sideName(r.pickSide()); // chỉ 'T' | 'CT'
    if (side !== 'T' && side !== 'CT') {
      log('Bỏ qua — bên không hợp lệ:', side);
      return;
    }

    // Kiểm tra đủ tiền TRƯỚC khi lệnh mức mới (đã x2) — không đủ thì dừng phiên sạch,
    // tránh vòng lặp retry vô hạn khi site từ chối lệnh vì thiếu saldo.
    var d0 = dom();
    var balNow = (d0 && typeof d0.getBalance === 'function') ? d0.getBalance() : null;
    if (typeof balNow !== 'number' || !isFinite(balNow)) balNow = liveBalance;
    if (typeof balNow !== 'number' || !isFinite(balNow)) {
      var st0 = stats();
      if (st0 && typeof st0.lastBalance === 'function') balNow = st0.lastBalance(session);
    }
    if (typeof balNow === 'number' && isFinite(balNow) && balNow < order) {
      log('Không đủ tiền: số dư', balNow, '< mức lệnh kế tiếp', order, '— dừng phiên.');
      endSession('Số dư ' + (Math.round(balNow * 100) / 100) + ' không đủ cho mức lệnh kế tiếp (' + order + ') — dừng để bảo toàn vốn.');
      return;
    }

    var d = dom();
    session.currentLevel = order;
    session.orderPlaced = true;
    // lastCount: số vòng đã chốt lúc đặt lệnh (đối chiếu history); fp: dấu vân
    // tay top-3 kết quả — cả hai dùng để chống ghi trùng vòng (NOTE #1).
    session.pendingOrder = {
      side: side, order: order, t: Date.now(),
      lastCount: countRounds(), fp: resultsFingerprint(3),
      bal0: (typeof balNow === 'number' && isFinite(balNow)) ? round2(balNow) : null
    };
    await persist(); // NGAY trước khi chạm UI — sống sót reload bất cứ lúc nào
    notify();

    var res = null;
    try {
      res = await d.placeOrder(side, order);
    } catch (e) {
      res = { ok: false, reason: String((e && e.message) || e) };
    }
    if (!res || !res.ok) {
      // NOTE Agent-D #2: reason ∈ DICE_BLOCKED / INVALID_SIDE / INVALID_AMOUNT /
      // UI_NOT_READY / INPUT_SET_FAILED / BUTTON_DISABLED / CLICK_FAILED.
      session.orderPlaced = false;
      session.pendingOrder = null;
      var failReason = (res && res.reason) ? String(res.reason) : 'CLICK_FAILED';
      session.lastPlaceError = failReason;
      if (failReason === 'INVALID_SIDE' || failReason === 'DICE_BLOCKED') {
        // Không bao giờ xảy ra vì engine chỉ gửi 'T'|'CT' — không retry mù.
        session.placeFailCount = 0;
        log('Đặt lệnh bị từ chối (' + failReason + ') — dừng vòng, không retry');
      } else {
        // UI_NOT_READY / INPUT_SET_FAILED / BUTTON_DISABLED / CLICK_FAILED /
        // INVALID_AMOUNT: lỗi tạm thời — tick sau thử lại (giữ phiên).
        session.placeFailCount = (session.placeFailCount || 0) + 1;
        log('Đặt lệnh chưa được (' + failReason + ') lần',
          session.placeFailCount, '— thử lại ở tick sau');
      }
      setNote('Chưa đặt được (' + failReason + ') — sẽ thử lại ở nhịp sau…');
      await persist();
      notify();
      return;
    }
    session.placeFailCount = 0;
    setNote('Đã đặt ' + order + ' vào ' + side + ' — chờ kết quả…');

    var pending = session.pendingOrder;
    var wr = await waitForResult(pending);
    if (wr.aborted) {
      if (wr.reason === 'TIMEOUT') {
        // Đã lệnh tiền nhưng không đọc được kết quả: bỏ pending, giữ currentLevel
        // để martingale không phình sai — vòng này được bỏ qua đối soát.
        session.orderPlaced = false;
        session.pendingOrder = null;
        log('Chờ kết quả quá 120s — bỏ đối soát vòng này');
        await persist();
        notify();
      }
      // BLOCKED: giữ nguyên pendingOrder, tick sau khi hết chặn sẽ đối soát tiếp.
      return;
    }
    await finishRound(wr.result, pending);
  }

  // ---- nhịp máy: main.js gọi lặp bằng setInterval ----
  async function tick() {
    if (busy || !session || session.phase !== 'RUNNING') return;
    var myToken = stopToken;
    busy = true;
    try {
      var c = cf();
      if (c && typeof c.isBlocked === 'function' && c.isBlocked()) {
        setNote('Trang bị chặn — tạm dừng…');
        notifyBlocked();
        if (myToken !== stopToken) return;
        return; // đang bị chặn — không đặt lệnh mới
      }
      var d = dom();
      if (d && typeof d.isUiReady === 'function' && !d.isUiReady()) { setNote('Chờ giao diện trang sẵn sàng…'); return; }
      if (myToken !== stopToken) return;

      if (session.orderPlaced) {
        // Vòng dang dở (có thể từ trước reload): đối soát trước, không lệnh mới.
        var pending = session.pendingOrder;
        if (!pending) {
          session.orderPlaced = false;
          await persist();
          return;
        }
        if (!pending.fp) {
          // Vòng dang dở sau reload, không có dấu vân tay: dựng lại từ trang
          // hiện tại để chờ dịch chuyển mới (không ghi trùng vòng cũ).
          pending.fp = resultsFingerprint(3);
          await persist();
        }
        var wr = await waitForResult(pending);
        if (wr.aborted) {
          if (wr.reason === 'TIMEOUT') {
            session.orderPlaced = false;
            session.pendingOrder = null;
            await persist();
            notify();
          }
          return;
        }
        await finishRound(wr.result, pending);
        return;
      }
      await placeNewBet();
    } finally {
      busy = false;
    }
  }

  // ---- phục hồi sau reload ----
  async function restoreAfterReload() {
    var st = storage();
    if (!st || typeof st.load !== 'function') {
      return { restored: false, phase: 'IDLE', reason: 'MartingaleStorage không khả dụng' };
    }
    var loaded = await st.load();
    if (!loaded) return { restored: false, phase: 'IDLE' };
    session = loaded;
    if (!Array.isArray(session.history)) session.history = [];
    if (!Array.isArray(session.chart)) session.chart = [];

    if (session.phase === 'ENDED') {
      summary = buildSummary(session.stopReason || 'Phiên đã kết thúc.');
      notify();
      return { restored: false, phase: 'ENDED' };
    }
    if (session.phase !== 'RUNNING' && session.phase !== 'BLOCKED') {
      notify();
      return { restored: false, phase: session.phase };
    }

    log('Phục hồi phiên', session.phase, 'sau reload — chờ UI sẵn sàng (tối đa 120s)');
    var deadline = Date.now() + RESTORE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      var c = cf();
      var d = dom();
      var blocked = (c && typeof c.isBlocked === 'function') ? c.isBlocked() : false;
      var ready = (d && typeof d.isUiReady === 'function') ? d.isUiReady() : true;
      if (!blocked && ready) {
        if (session.phase === 'BLOCKED' && session.wasRunningBeforeBlock) {
          session.phase = 'RUNNING';
          session.wasRunningBeforeBlock = false;
        }
        await persist();
        notify();
        log('UI sẵn sàng — tiếp tục RUNNING,', session.rounds, 'vòng đã chơi');
        return { restored: true, phase: session.phase };
      }
      await sleep(RESTORE_POLL_MS);
    }

    session.phase = 'PAUSED';
    session.pauseReason = 'Không tìm thấy UI game sau 120 giây kể từ khi tải lại trang. Kiểm tra trang rồi bấm "Tiếp tục".';
    await persist();
    notify();
    log('Quá 120s chờ UI — chuyển PAUSED');
    return { restored: false, phase: 'PAUSED', reason: session.pauseReason };
  }

  // ---- số dư nhập tay (MANUAL) — main nối từ MartingaleDOM.onManualBalance ----
  function setLiveBalance(value) {
    liveBalance = (typeof value === 'number' && isFinite(value)) ? round2(value) : null;
  }

  /** Reset an toàn (nút "Đặt lại" trên UI): hủy mọi chờ lệnh dang dở rồi ENDED.
   * tick() và waitForResult() kiểm tra stopToken nên không bao giờ đụng storage
   * hay DOM sau khi hàm này trả về — có thể startNew phiên mới ngay lập tức. */
  function resetForNewSession(opts) {
    stopToken = (stopToken || 0) + 1;
    var o = opts || {};
    var prevBaseBet = session ? session.baseLevel : null;
    var prevBaseBal = session ? session.baseBalance : null;
    if (session) {
      session.orderPlaced = false;
      session.pendingOrder = null;
      endSession('Đã đặt lại thủ công — phiên mới sẵn sàng.');
    }
    // Phiên chờ mới: số dư gốc = số dư HIỆN TẠI (nếu đọc được), mức lệnh gốc giữ
    // lại từ phiên cũ để người dùng chỉnh rồi bấm Bắt đầu.
    var fresh = freshSession();
    var bb = (o.baseLevel != null) ? Number(o.baseLevel) : prevBaseBet;
    fresh.baseLevel = Math.max(0.01, round2(isFinite(bb) ? bb : 0.01));
    var base = (typeof o.baseBalance === 'number' && isFinite(o.baseBalance)) ? o.baseBalance : prevBaseBal;
    if (isFinite(base)) fresh.baseBalance = round2(base);
    fresh.phase = 'IDLE';
    fresh.note = 'Đã đặt lại — số dư gốc = số dư hiện tại. Chỉnh mức lệnh gốc rồi bấm Bắt đầu.';
    session = fresh;
    persist();
    notify();
    return session;
  }

  // ---- API công khai ----
  root.MartingaleEngine = {
    startNew: startNew,
    resetForNewSession: resetForNewSession,
    pause: pause,
    resume: resume,
    notifyBlocked: notifyBlocked,
    notifyUnblocked: notifyUnblocked,
    restoreAfterReload: restoreAfterReload,
    tick: tick,
    onChange: onChange,
    getSession: function () { return session; },
    getPhase: function () { return session ? session.phase : 'IDLE'; },
    getSummary: function () { return summary; },
    setLiveBalance: setLiveBalance
  };
})();
