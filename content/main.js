/**
 * main.js — Entry point Martingale Extension Dashboard (Agent-F).
 *
 * Thứ tự khởi động theo CONTRACT:
 *   load storage → MartingaleCF.start → MartingaleDOM.init → MartingaleUI.mount
 *   → MartingaleEngine.restoreAfterReload → nối callbacks:
 *   UI → engine · engine → UI/chart · CF → engine + UI · DOM.manual → UI
 *
 * Quy tắc sở hữu dữ liệu:
 *  - Có MartingaleEngine → engine là chủ phiên: mọi thay đổi do engine lưu vào
 *    MartingaleStorage; main.js chỉ ĐỌC storage (poll 1s) để cập nhật UI/chart,
 *    KHÔNG ghi đè storage bằng bản sao cục bộ.
 *  - Không có MartingaleEngine (mock/môi trường thiếu module) → main.js tự quản
 *    phiên tối thiểu và tự lưu để dashboard vẫn dùng được.
 * Mọi lời gọi module anh em đều bọc try/catch để 1 lỗi không sập dashboard.
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  const log = function () {
    try { console.log.apply(console, ['[Martingale]'].concat([].slice.call(arguments))); } catch (e) { /* im lặng */ }
  };
  const warn = function () {
    try { console.warn.apply(console, ['[Martingale]'].concat([].slice.call(arguments))); } catch (e) { /* im lặng */ }
  };

  function has(name) { return typeof root[name] === 'object' && root[name] !== null; }

  let session = null;
let suppressSummaryMs = 0;          // bản snapshot mới nhất biết được
  const engineOwned = has('MartingaleEngine');

  // ---------- tiện ích phiên (chỉ dùng khi engine vắng mặt) ----------
  function freshSession(baseLevel, baseBalance) {
    const s = (has('MartingaleStorage') && typeof MartingaleStorage.defaultSession === 'function')
      ? MartingaleStorage.defaultSession()
      : { baseLevel: 100, phase: 'IDLE', wasRunningBeforeBlock: false, baseBalance: null,
          currentLevel: null, orderPlaced: false, rounds: 0, wins: 0, losses: 0,
          currentLossStreak: 0, maxLossStreak: 0, profit: 0, history: [], chart: [] };
    s.baseLevel = Math.max(0.01, Math.round((Number(baseLevel) || 0) * 100) / 100);
    s.baseBalance = Math.round((Number(baseBalance) || 0) * 100) / 100;
    return s;
  }

  async function persistLocal() {
    if (engineOwned || !session || !has('MartingaleStorage')) return;
    try { await MartingaleStorage.save(session); } catch (e) { warn('Lưu storage lỗi:', e); }
  }

  function refresh() {
    if (!session) return;
    if (has('MartingaleUI')) { try { MartingaleUI.update(session); } catch (e) { warn('UI.update:', e); } }
  }

  function pushChartPoint(balance) {
    try {
      const t = Date.now();
      const b = Math.round((Number(balance) || 0) * 100) / 100;
      if (has('MartingaleChart')) MartingaleChart.push({ t: t, balance: b });
      if (!engineOwned && session) {
        if (!Array.isArray(session.chart)) session.chart = [];
        session.chart.push({ t: t, balance: b });
      }
    } catch (e) { warn('Chart.push:', e); }
  }

  function readBetInput() {
    const inp = document.getElementById('mg-order');
    const v = inp ? parseInt(inp.value, 10) : NaN;
    return (isFinite(v) && v > 0) ? v : 100;
  }

  // ---------- callbacks UI → engine ----------
  // Nút "Đặt lại": hủy phiên hiện tại sạch (hết token các tick cũ), đọc lại số dư,
  // mở khóa ô nhập mức lệnh gốc. Người dùng gõ mức mới rồi bấm "Bắt đầu" = phiên mới.
  function uiReset() {
    try {
      if (has('MartingaleEngine') && typeof MartingaleEngine.resetForNewSession === 'function') {
        MartingaleEngine.resetForNewSession();
      }
      suppressSummaryMs = Date.now() + 8000;
      if (has('MartingaleUI') && typeof MartingaleUI.hideSummary === 'function') MartingaleUI.hideSummary();
      let bal = null;
      try { bal = MartingaleDOM.getBalance(); } catch (e) { bal = null; }
      if (has('MartingaleUI')) {
        if (typeof MartingaleUI.setPhase === 'function') MartingaleUI.setPhase('ENDED');
        if (typeof MartingaleUI.update === 'function' && bal != null) MartingaleUI.update({ phase: 'ENDED', balance: bal });
      }
      log('Đặt lại: phiên cũ kết thúc, số dư đọc lại =', bal, '— chờ CEO nhập mức lệnh gốc mới.');
    } catch (e) { warn('uiReset:', e); }
  }

  function uiStart(baseLevel) {
    try {
      // đọc số dư hiện tại làm mốc gốc
      let bal = null;
      if (has('MartingaleDOM')) {
        try { bal = MartingaleDOM.getBalance(); } catch (e) { bal = null; }
      }
      if (bal == null || !isFinite(bal)) {
        if (has('MartingaleUI')) MartingaleUI.setManual(true);
        warn('Chưa đọc được số dư — hãy nhập số dư tay để bắt đầu phiên.');
        return;
      }
      bal = Math.round(bal * 100) / 100;
      if (engineOwned) {
        try { MartingaleEngine.startNew(baseLevel, bal); } catch (e) { warn('Engine.startNew:', e); }
        session = freshSession(baseLevel, bal); // chỉ để UI phản hồi tức thì; poll sẽ thay bằng bản engine
        session.phase = 'RUNNING';
      } else {
        session = freshSession(baseLevel, bal);
        session.phase = 'RUNNING';
        pushChartPoint(bal);
        persistLocal();
      }
      if (has('MartingaleChart')) {
        try { MartingaleChart.setData(session.chart || []); } catch (e) { /* bỏ qua */ }
      }
      if (has('MartingaleUI')) MartingaleUI.setPhase('RUNNING');
      refresh();
      log('Bắt đầu phiên mới: lệnh gốc', baseLevel, '· mốc', bal);
    } catch (e) { warn('uiStart:', e); }
  }

  function uiPause() {
    try {
      if (engineOwned) {
        try { MartingaleEngine.pause(); } catch (e) { warn('Engine.pause:', e); }
      } else if (session) {
        session.phase = 'PAUSED';
        persistLocal();
      }
      if (has('MartingaleUI')) MartingaleUI.setPhase('PAUSED');
      log('Tạm dừng phiên.');
    } catch (e) { warn('uiPause:', e); }
  }

  function uiResume() {
    try {
      if (engineOwned) {
        try { MartingaleEngine.resume(); } catch (e) { warn('Engine.resume:', e); }
      } else if (session) {
        session.phase = 'RUNNING';
        persistLocal();
      }
      if (has('MartingaleUI')) MartingaleUI.setPhase('RUNNING');
      log('Tiếp tục phiên.');
    } catch (e) { warn('uiResume:', e); }
  }

  // Người dùng nhập số dư tay (ô MANUAL của UI) → MartingaleDOM.setManualBalance(v)
  function uiManualBalance(amount) {
    try {
      const v = Math.max(0, Math.round((Number(amount) || 0) * 100) / 100);
      if (has('MartingaleDOM') && typeof MartingaleDOM.setManualBalance === 'function') {
        try { MartingaleDOM.setManualBalance(v); } catch (e) { warn('DOM.setManualBalance:', e); }
      }
      // chưa có phiên mà người dùng chủ động nhập dư → cho phép bắt đầu ở chế độ MANUAL
      if (!session || session.phase === 'IDLE' || session.phase === 'ENDED') {
        const order = readBetInput();
        if (engineOwned) {
          try { MartingaleEngine.startNew(order, v); } catch (e) { warn('Engine.startNew:', e); }
          session = freshSession(order, v);
          session.phase = 'RUNNING';
        } else {
          session = freshSession(order, v);
          session.phase = 'RUNNING';
          pushChartPoint(v);
          persistLocal();
        }
        if (has('MartingaleChart')) { try { MartingaleChart.setData(session.chart || []); } catch (e) { /* bỏ qua */ } }
        if (has('MartingaleUI')) MartingaleUI.setPhase('RUNNING');
        refresh();
        log('Bắt đầu phiên (MANUAL): mốc', v);
      } else if (!engineOwned) {
        pushChartPoint(v);
        persistLocal();
      }
    } catch (e) { warn('uiManualBalance:', e); }
  }

  // ---------- Cloudflare → engine + UI ----------
  function onCfChange(blocked, reason) {
    try {
      if (engineOwned) {
        if (blocked) {
          try { MartingaleEngine.notifyBlocked(); } catch (e) { warn('Engine.notifyBlocked:', e); }
        } else {
          try { MartingaleEngine.notifyUnblocked(); } catch (e) { warn('Engine.notifyUnblocked:', e); }
        }
      } else if (session) {
        if (blocked && session.phase === 'RUNNING') {
          session.wasRunningBeforeBlock = true;
          session.phase = 'BLOCKED';
          persistLocal();
        } else if (!blocked && session.phase === 'BLOCKED') {
          session.phase = 'PAUSED';
          persistLocal();
        }
        if (has('MartingaleUI')) MartingaleUI.setPhase(session.phase);
      }
      if (has('MartingaleUI')) MartingaleUI.setBlocked(!!blocked, reason);
      log(blocked ? 'Cloudflare chặn: ' + (reason || '') : 'Cloudflare đã qua.');
    } catch (e) { warn('onCfChange:', e); }
  }

  // ---------- DOM.manual → UI (quét hụt số dư 3 lần liên tiếp) ----------
  function onDomManual() {
    try { if (has('MartingaleUI')) MartingaleUI.setManual(true); } catch (e) { warn('onDomManual:', e); }
  }

  // ---------- poll storage → UI/chart (engine là nguồn chuẩn) ----------
  function watchEngine() {
    setInterval(function () {
      (async function () {
        try {
          if (!has('MartingaleStorage') || !engineOwned) return;
          let s = null;
          try { s = await MartingaleStorage.load(); } catch (e) { s = null; }
          if (!s) return;
          const prevRounds = session ? session.rounds : -1;
          const prevPhase = session ? session.phase : null;
          session = s;
          if (s.rounds !== prevRounds) {
            refresh(); // thống kê + phase mới nhất
            // đẩy điểm chart nếu engine chưa kịp đẩy (tránh trùng: so sánh nghiêm < )
            const hb = (s.history && s.history.length) ? s.history[s.history.length - 1] : null;
            const lastC = (s.chart && s.chart.length) ? s.chart[s.chart.length - 1] : null;
            if (hb && (!lastC || lastC.t < hb.t)) pushChartPoint(hb.balance);
          }
          if (s.phase !== prevPhase) {
            if (has('MartingaleUI')) {
              MartingaleUI.setPhase(s.phase);
              if (s.phase === 'BLOCKED') MartingaleUI.setBlocked(true);
            }
            if (s.phase === 'ENDED') {
              refresh();
              if (Date.now() > suppressSummaryMs && has('MartingaleUI')) MartingaleUI.showSummary(s);
            }
          }
        } catch (e) { warn('watchEngine:', e); }
      })();
    }, 1000);
  }

  // Dò DOM hỏng lâu → mở ô nhập tay (phòng khi onManualBalance chưa kịp bắn)
  function watchDomHealth() {
    setInterval(function () {
      try {
        if (!has('MartingaleDOM') || !has('MartingaleUI')) return;
        if (typeof MartingaleDOM.isUiReady !== 'function') return;
        let ready = true;
        try { ready = !!MartingaleDOM.isUiReady(); } catch (e) { ready = false; }
        if (!ready) MartingaleUI.setManual(true);
      } catch (e) { warn('watchDomHealth:', e); }
    }, 5000);
  }

  // ---------- nhích máy: gọi MartingaleEngine.tick() lặp ----------
  // tick() của engine KHÔNG tự lên lịch và tự chống re-entry (cờ busy) —
  // main gọi an toàn mỗi 1.5s; kiểm tra has() mỗi nhịp nên engine xuất hiện
  // muộn (mock) vẫn được phủ.
  // Chống điều tiết timer tab nền: giữ 1 Web Lock không bao giờ giải phóng.
  // Chrome miễn "intensive throttling" (1 lần/phút sau 5 phút nền) cho trang giữ Web Lock —
  // còn lại chỉ sàn 1 lần/giây, đủ cho nhịp tick 1.5s của engine.
  try {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      navigator.locks.request('martingale-keepalive', function () { return new Promise(function () {}); });
    }
  } catch (eLock) { /* trình duyệt không hỗ trợ — vẫn chạy, chỉ chậm hơn khi nền */ }

  function watchEngineTick() {
    setInterval(function () {
      if (!has('MartingaleEngine')) return;
      try { MartingaleEngine.tick(); } catch (e) { /* lỗi 1 nhịp → bỏ qua, nhịp sau gọi lại */ }
    }, 1500);
  }

  // ---------- khởi động ----------
  async function boot() {
    if (root.__martingale_MAIN_BOOTED__) return;
    root.__martingale_MAIN_BOOTED__ = true;

    // 1) load storage
    if (has('MartingaleStorage')) {
      try { session = await MartingaleStorage.load(); } catch (e) { session = null; warn('Load storage:', e); }
    }
    log('Khởi động. Phiên lưu:', session ? session.phase : 'không có', engineOwned ? '(engine)' : '(không có engine)');

    // 2) CF watch — onChange bắn ngay khi đăng ký (Agent-D) → banner cập nhật tức thì
    if (has('MartingaleCF')) {
      try {
        MartingaleCF.start();
        if (typeof MartingaleCF.onChange === 'function') MartingaleCF.onChange(onCfChange);
      } catch (e) { warn('CF.start:', e); }
    }

    // 3) DOM init — đăng ký callback MANUAL trước khi init (Agent-D)
    if (has('MartingaleDOM')) {
      try {
        if (typeof MartingaleDOM.onManualBalance === 'function') MartingaleDOM.onManualBalance(onDomManual);
        MartingaleDOM.init({ pollMs: 1000 });
      } catch (e) { warn('DOM.init:', e); }
    }

    // 4) UI mount + chart gắn vào trong panel (đi cùng khi kéo)
    if (has('MartingaleUI')) {
      try {
        MartingaleUI.mount({
          onStart: uiStart,
          onPause: uiPause,
          onResume: uiResume,
          onManualBalance: uiManualBalance
        });
      } catch (e) { warn('UI.mount:', e); }
    }
    if (has('MartingaleChart')) {
      try {
        const host = document.getElementById('mg-body');
        if (host) {
          const holder = document.createElement('div');
          holder.style.marginTop = '8px';
          const csvBtn = document.getElementById('mg-csv');
          if (csvBtn && csvBtn.parentNode === host) host.insertBefore(holder, csvBtn);
          else host.appendChild(holder);
          MartingaleChart.mount(holder);
          MartingaleChart.setData(session && session.chart ? session.chart : []);
        }
      } catch (e) { warn('Chart.mount:', e); }
    }

    // 5) khôi phục phiên sau reload
    if (session && engineOwned) {
      try {
        if (typeof MartingaleEngine.restoreAfterReload === 'function') MartingaleEngine.restoreAfterReload();
      } catch (e) { warn('Engine.restoreAfterReload:', e); }
    }

    // 6) UI phản ánh phiên hiện có
    if (has('MartingaleUI')) {
      try {
        if (session) MartingaleUI.update(session);
        MartingaleUI.setPhase(session ? session.phase : 'IDLE');
        let blockedNow = false;
        if (has('MartingaleCF') && typeof MartingaleCF.isBlocked === 'function') {
          try { blockedNow = !!MartingaleCF.isBlocked(); } catch (e) { blockedNow = false; }
        }
        MartingaleUI.setBlocked(blockedNow);
        if (blockedNow && session && session.phase === 'RUNNING') {
          session.phase = 'BLOCKED'; // chỉ bản hiển thị; engine tự xử lý storage
        }
        if (session && session.phase === 'ENDED') MartingaleUI.showSummary(session);
      } catch (e) { warn('UI init:', e); }
    }

    // 7) vòng đồng bộ + nhích máy (sau restoreAfterReload ở bước 5)
    watchEngine();
    watchDomHealth();
    watchEngineTick();
    log('Sẵn sàng.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    boot();
  }
})();
