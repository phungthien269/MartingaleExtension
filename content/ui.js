/**
 * ui.js — Panel nổi điều khiển + thống kê + tổng kết (Agent-F).
 *
 * API theo CONTRACT:
 *  - .mount(callbacks)            : gắn panel nổi (kéo di chuyển được) vào document.body
 *  - .update(session)             : làm mới thống kê từ session (MartingaleEngine gọi sau mỗi vòng)
 *  - .setPhase(phase)             : 'IDLE'|'RUNNING'|'PAUSED'|'BLOCKED'|'ENDED' → đổi trạng thái nút
 *  - .setBlocked(blocked, reason) : hiện/ẩn banner vàng-đỏ khi bị Cloudflare
 *  - .setManual(on)               : hiện/ẩn ô nhập số dư tay (chế độ MANUAL)
 *  - .showSummary(session)        : modal tổng kết khi phiên ENDED
 * callbacks: { onStart(baseLevel), onPause(), onResume(), onManualBalance(amount), onReset() }
 * Dark mode, text tiếng Việt có dấu, KHÔNG thư viện ngoài.
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  const PHASES = ['IDLE', 'RUNNING', 'PAUSED', 'BLOCKED', 'ENDED'];
  const PHASE_TEXT = {
    IDLE: 'Sẵn sàng',
    RUNNING: 'Đang chạy',
    PAUSED: 'Tạm dừng',
    BLOCKED: 'Bị Cloudflare chặn',
    ENDED: 'Đã kết thúc'
  };

  const cb = {
    onStart: null, onPause: null, onResume: null, onManualBalance: null
  };

  const el = {};      // tham chiếu phần tử
  let lastPhase = null;
  let lastSummaryKey = '';
  let latest = null;  // session mới nhất để xuất CSV

  // ---------- tiện ích ----------
  function fmtNum(n) {
    try { return new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(n) || 0); }
    catch (e) { return String(Math.round((Number(n) || 0) * 100) / 100); }
  }
  function fmtProfit(n) {
    n = Math.round((Number(n) || 0) * 100) / 100;
    return (n > 0 ? '+' : (n < 0 ? '−' : '')) + fmtNum(Math.abs(n));
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtClock(t) {
    const d = new Date(t);
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  // ---------- style ----------
  function ensureStyles() {
    if (document.getElementById('mg-ui-style')) return;
    const tag = document.createElement('style');
    tag.id = 'mg-ui-style';
    tag.textContent = [
      '#mg-panel{position:fixed;top:64px;right:12px;width:284px;z-index:2147483600;',
      'font:13px/1.45 system-ui,-apple-system,sans-serif;color:#e8ecf4;background:#141a26;',
      'border:1px solid #2f3a52;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.55);user-select:none}',
      '#mg-panel *{box-sizing:border-box}',
      '#mg-drag{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;',
      'background:linear-gradient(180deg,#1b2334,#161d2c);border-bottom:1px solid #2f3a52;border-radius:12px 12px 0 0}',
      '#mg-drag .mg-title{flex:1;font-weight:700;font-size:13px;letter-spacing:.2px}',
      '#mg-phase{font-size:11px;padding:2px 8px;border-radius:99px;background:#232c40;color:#aeb8cf}',
      '#mg-phase.p-running{background:#12351f;color:#5ee08a}',
      '#mg-phase.p-paused{background:#3a3113;color:#ffd166}',
      '#mg-phase.p-blocked{background:#3d1414;color:#ff7b72}',
      '#mg-phase.p-ended{background:#1e2a44;color:#7fb0ff}',
      '#mg-collapse{background:#232c40;color:#aeb8cf;border:none;border-radius:6px;width:22px;height:22px;cursor:pointer;font-size:12px;line-height:1}',
      '#mg-collapse:hover{background:#2c3750}',
      '#mg-banner{display:none;margin:8px 10px 0;padding:8px 10px;border-radius:8px;font-size:12px;',
      'background:linear-gradient(90deg,#ffd16633,#ff5f5633);border:1px solid #ffb347;color:#ffd166}',
      '#mg-banner b{color:#ff8a80}',
      '#mg-manual{display:none;margin:8px 10px 0;padding:8px 10px;border:1px dashed #4da3ff;border-radius:8px;font-size:12px;color:#aeb8cf}',
      '#mg-manual .mg-row{display:flex;gap:6px;margin-top:6px}',
      '#mg-body{padding:10px}',
      '.mg-lab{display:block;font-size:11px;color:#8b93a7;margin:0 0 3px}',
      'input.mg-inp{width:100%;background:#0e1420;color:#e8ecf4;border:1px solid #2f3a52;',
      'border-radius:8px;padding:6px 8px;font:13px system-ui,sans-serif;user-select:text}',
      'input.mg-inp:focus{outline:none;border-color:#4da3ff}',
      'input.mg-inp:disabled{opacity:.5}',
      '.mg-btns{display:flex;gap:6px;margin:10px 0 2px}',
      'button.mg-btn{flex:1;padding:7px 0;border:none;border-radius:8px;cursor:pointer;',
      'font:600 12px system-ui,sans-serif;color:#e8ecf4;background:#232c40}',
      'button.mg-btn:hover:not(:disabled){filter:brightness(1.2)}',
      'button.mg-btn:disabled{opacity:.35;cursor:not-allowed}',
      '#mg-start{background:#1f7a3d}#mg-pause{background:#8a6d1f}#mg-resume{background:#1f5f8a}',
      '#mg-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0 2px}',
      '.mg-cell{background:#0e1420;border:1px solid #232c40;border-radius:8px;padding:5px 8px}',
      '.mg-cell .k{font-size:10px;color:#8b93a7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mg-cell .v{font-size:13px;font-weight:700;margin-top:1px}',
      '.v.good{color:#5ee08a}.v.bad{color:#ff7b72}.v.warn{color:#ffd166}',
      '#mg-csv{width:100%;margin-top:8px;background:#232c40;color:#aeb8cf;border:1px solid #2f3a52;',
      'border-radius:8px;padding:6px 0;cursor:pointer;font:12px system-ui,sans-serif}',
      '#mg-csv:hover{background:#2c3750}',
      '#mg-err{color:#ff7b72;font-size:11px;margin-top:4px;min-height:14px}',
      '#mg-sumback{display:none;position:fixed;inset:0;z-index:2147483700;background:rgba(5,8,14,.72);',
      'align-items:center;justify-content:center}',
      '#mg-sumback.show{display:flex}',
      '#mg-sum{width:min(360px,92vw);background:#141a26;border:1px solid #2f3a52;border-radius:14px;',
      'padding:16px;color:#e8ecf4;box-shadow:0 12px 40px rgba(0,0,0,.6)}',
      '#mg-sum h2{margin:0 0 2px;font-size:16px}',
      '#mg-sum .sub{font-size:11px;color:#8b93a7;margin-bottom:10px}',
      '#mg-sum .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '#mg-sum button{width:100%;margin-top:12px;padding:8px 0;border:none;border-radius:8px;',
      'background:#1f5f8a;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer}',
      '.mg-only-collapsed #mg-body,.mg-only-collapsed #mg-banner,.mg-only-collapsed #mg-manual{display:none!important}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(tag);
  }

  // ---------- dựng panel ----------
  function h(tagName, cls, html) {
    const e = document.createElement(tagName);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function mount(callbacks) {
    if (el.panel && el.panel.parentNode) return el.panel;
    ensureStyles();
    Object.assign(cb, {
      onStart: callbacks && callbacks.onStart,
      onPause: callbacks && callbacks.onPause,
      onResume: callbacks && callbacks.onResume,
      onManualBalance: callbacks && callbacks.onManualBalance
    });

    const panel = h('div');
    panel.id = 'mg-panel';

    // ---- thanh kéo di chuyển ----
    const drag = h('div');
    drag.id = 'mg-drag';
    const title = h('span', 'mg-title', '🎲 Martingale Panel');
    const phase = h('span');
    phase.id = 'mg-phase';
    phase.textContent = PHASE_TEXT.IDLE;
    const collapse = h('button');
    collapse.id = 'mg-collapse';
    collapse.type = 'button';
    collapse.textContent = '▾';
    collapse.title = 'Thu nhỏ / Mở rộng panel';
    drag.appendChild(title);
    drag.appendChild(phase);
    drag.appendChild(collapse);

    // ---- banner Cloudflare ----
    const banner = h('div');
    banner.id = 'mg-banner';
    banner.innerHTML = '⚠️ <b>Bị Cloudflare chặn!</b> <span id="mg-banner-txt">Phiên tạm dừng, tự tiếp tục sau khi qua kiểm tra.</span>';

    // ---- ô nhập số dư tay (MANUAL) ----
    const manual = h('div');
    manual.id = 'mg-manual';
    manual.innerHTML =
      'Không đọc được số dư trên trang — nhập số dư hiện tại:' +
      '<div class="mg-row"><input class="mg-inp" id="mg-manual-inp" type="number" min="0" step="1" placeholder="Ví dụ: 12500">' +
      '<button class="mg-btn" id="mg-manual-save" style="flex:0 0 auto;padding:6px 10px">Lưu</button></div>';

    // ---- thân panel ----
    const body = h('div');
    body.id = 'mg-body';

    const labBet = h('label', 'mg-lab');
    labBet.htmlFor = 'mg-order';
    labBet.textContent = 'Mức lệnh gốc (coin)';
    const order = h('input', 'mg-inp');
    order.id = 'mg-order';
    order.type = 'number';
    order.min = '1';
    order.step = '1';
    order.placeholder = '100';
    order.value = '100';

    const btns = h('div', 'mg-btns');
    const bStart = h('button', 'mg-btn');
    bStart.id = 'mg-start'; bStart.type = 'button'; bStart.textContent = 'Bắt đầu';
    const bPause = h('button', 'mg-btn');
    bPause.id = 'mg-pause'; bPause.type = 'button'; bPause.textContent = 'Tạm dừng';
    const bResume = h('button', 'mg-btn');
    bResume.id = 'mg-resume'; bResume.type = 'button'; bResume.textContent = 'Tiếp tục';
    const bReset = h('button', 'mg-btn');
    bReset.id = 'mg-reset'; bReset.type = 'button'; bReset.textContent = 'Đặt lại';
    bReset.title = 'Kết thúc phiên hiện tại, đọc lại số dư trên trang, cho nhập lại mức lệnh gốc';
    btns.appendChild(bStart); btns.appendChild(bPause); btns.appendChild(bResume); btns.appendChild(bReset);

    const stats = h('div');
    stats.id = 'mg-stats';
    stats.innerHTML =
      '<div id="emp-note" style="grid-column:1/-1;color:#93a0b8;font-size:11px;min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</div>' +
      cell('Vòng', 'st-rounds') + cell('Thắng', 'st-wins') +
      cell('Thua', 'st-losses') + cell('Chuỗi thua hiện tại', 'st-streak') +
      cell('Chuỗi thua dài nhất', 'st-maxstreak') + cell('Lời / Lỗ', 'st-profit') +
      cell('Số dư gốc', 'st-basebal') + cell('Lệnh hiện tại', 'st-order') + cell('Số dư', 'st-balance');
    function cell(k, id) {
      return '<div class="mg-cell"><div class="k">' + k + '</div><div class="v" id="' + id + '">—</div></div>';
    }

    const csv = h('button');
    csv.id = 'mg-csv'; csv.type = 'button'; csv.textContent = '⬇ Xuất CSV (lịch sử vòng)';
    const err = h('div');
    err.id = 'mg-err';

    body.appendChild(labBet); body.appendChild(order);
    body.appendChild(btns);
    body.appendChild(stats);
    body.appendChild(csv);
    body.appendChild(err);

    // ---- modal tổng kết ----
    const sumback = h('div');
    sumback.id = 'mg-sumback';
    const sum = h('div');
    sum.id = 'mg-sum';
    sumback.appendChild(sum);

    panel.appendChild(drag);
    panel.appendChild(banner);
    panel.appendChild(manual);
    panel.appendChild(body);
    (document.body || document.documentElement).appendChild(panel);

    Object.assign(el, {
      panel: panel, drag: drag, phase: phase, collapse: collapse, bReset: bReset,
      banner: banner, bannerTxt: banner.querySelector('#mg-banner-txt'),
      manual: manual, manualInp: manual.querySelector('#mg-manual-inp'),
      manualSave: manual.querySelector('#mg-manual-save'),
      order: order, bStart: bStart, bPause: bPause, bResume: bResume,
      note: stats.querySelector('#emp-note'),
      rounds: stats.querySelector('#st-rounds'), wins: stats.querySelector('#st-wins'),
      losses: stats.querySelector('#st-losses'), streak: stats.querySelector('#st-streak'),
      maxStreak: stats.querySelector('#st-maxstreak'), profit: stats.querySelector('#st-profit'),
      baseBal: stats.querySelector('#st-basebal'), curBet: stats.querySelector('#st-order'), balance: stats.querySelector('#st-balance'),
      csv: csv, err: err, sumback: sumback, sum: sum
    });

    // ---- sự kiện ----
    drag.addEventListener('pointerdown', onDragStart);
    collapse.addEventListener('click', function () {
      panel.classList.toggle('mg-only-collapsed');
      collapse.textContent = panel.classList.contains('mg-only-collapsed') ? '▸' : '▾';
    });
    order.addEventListener('input', function () { betTouched = true; });
    bStart.addEventListener('click', onStartClick);
    bPause.addEventListener('click', function () { if (cb.onPause) cb.onPause(); });
    bResume.addEventListener('click', function () { if (cb.onResume) cb.onResume(); });
    // Phím tắt (background.js forward martingale_TOGGLE_PANEL): thu/phóng dashboard
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function (msg) {
          if (msg && msg.type === 'martingale_TOGGLE_PANEL') {
            panel.classList.toggle('mg-only-collapsed');
            collapse.textContent = panel.classList.contains('mg-only-collapsed') ? '▸' : '▾';
          }
        });
      }
    } catch (e0) { /* mock/env không có chrome.runtime */ }

    bReset.addEventListener('click', function () {
      try {
        const want = typeof window !== 'undefined' && window.confirm
          ? window.confirm('Đặt lại phiên? Phiên hiện tại sẽ kết thúc, đọc lại số dư và cho nhập mức lệnh gốc mới.')
          : true;
        if (!want) return;
        if (cb.onReset) cb.onReset();
        if (typeof hideSummary === 'function') hideSummary();
      } catch (e) { console.warn('[MartingaleUI] reset:', e); }
    });
    csv.addEventListener('click', exportCsv);
    el.manualSave.addEventListener('click', saveManual);
    el.manualInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveManual();
    });
    sumback.addEventListener('click', function (e) {
      if (e.target === sumback) hideSummary();
    });

    setPhase('IDLE');
    return panel;
  }

  // ---------- kéo di chuyển ----------
  function onDragStart(e) {
    if (e.target.closest && e.target.closest('#mg-collapse')) return;
    const p = el.panel;
    const r = p.getBoundingClientRect();
    const offX = e.clientX - r.left;
    const offY = e.clientY - r.top;
    p.style.right = 'auto';
    p.style.left = r.left + 'px';
    p.style.top = r.top + 'px';
    function move(ev) {
      const w = p.offsetWidth, hgt = p.offsetHeight;
      let x = ev.clientX - offX;
      let y = ev.clientY - offY;
      x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
      y = Math.max(4, Math.min(y, window.innerHeight - Math.min(hgt, 48) - 4));
      p.style.left = x + 'px';
      p.style.top = y + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  }

  // ---------- nút Bắt đầu ----------
  function onStartClick() {
    const v = Math.round(parseFloat(String(el.order.value).replace(',', '.')) * 100) / 100;
    if (!isFinite(v) || v <= 0) {
      el.err.textContent = 'Mức lệnh phải là số > 0 (tối đa 2 chữ số thập phân, ví dụ 0.01).';
      el.order.focus();
      return;
    }
    el.err.textContent = '';
    if (cb.onStart) cb.onStart(v);
  }

  function saveManual() {
    const v = Math.round(parseFloat(String(el.manualInp.value).replace(',', '.')) * 100) / 100;
    if (!isFinite(v) || v < 0) {
      el.manualInp.focus();
      return;
    }
    if (cb.onManualBalance) cb.onManualBalance(v);
    el.manual.style.display = 'none';
  }

  // ---------- trạng thái ----------
  function setPhase(phase) {
    if (PHASES.indexOf(phase) < 0) phase = 'IDLE';
    lastPhase = phase;
    if (el.phase) {
      el.phase.textContent = PHASE_TEXT[phase];
      el.phase.className = '';
      if (phase === 'RUNNING') el.phase.classList.add('p-running');
      else if (phase === 'PAUSED') el.phase.classList.add('p-paused');
      else if (phase === 'BLOCKED') el.phase.classList.add('p-blocked');
      else if (phase === 'ENDED') el.phase.classList.add('p-ended');
    }
    const idle = phase === 'IDLE' || phase === 'ENDED';
    const running = phase === 'RUNNING';
    const paused = phase === 'PAUSED';
    if (el.bStart) el.bStart.disabled = !idle;
    if (el.bPause) el.bPause.disabled = !running;
    if (el.bResume) el.bResume.disabled = !(paused || phase === 'BLOCKED');
    if (el.order) el.order.disabled = phase === 'RUNNING' || phase === 'PAUSED' || phase === 'BLOCKED';
    if (el.bReset) el.bReset.disabled = phase === 'IDLE';
    if (phase === 'ENDED' || idle) {
      if (el.order && el.order.value === '') el.order.value = '100';
    }
  }

  function setBlocked(blocked, reason) {
    if (!el.banner) return;
    el.banner.style.display = blocked ? 'block' : 'none';
    if (blocked && reason) el.bannerTxt.textContent = String(reason);
    else el.bannerTxt.textContent = 'Phiên tạm dừng, tự tiếp tục sau khi qua kiểm tra.';
    if (blocked) setPhase('BLOCKED');
    else if (lastPhase === 'BLOCKED') setPhase('PAUSED');
  }

  function setManual(on) {
    if (!el.manual) return;
    el.manual.style.display = on ? 'block' : 'none';
    if (on) {
      try { el.manualInp.focus(); } catch (e) { /* bỏ qua */ }
    }
  }

  // ---------- cập nhật thống kê ----------
  let betTouched = false; // true khi người dùng tự gõ mức lệnh gốc

  function update(session) {
    if (!session || !el.rounds) return;
    // cập nhật cục bộ (chỉ liveBalance/note) → gộp vào phiên đầy đủ đang có.
    // QUAN TRỌNG: bản cục bộ KHÔNG được phép đổi phase/nút bấm — phase cũ trong
    // latest có thể là RUNNING/ENDED đã qua, đè mất trạng thái mới (ví dụ IDLE
    // sau khi Đặt lại) khiến ô nhập khóa và nút Bắt đầu bấm không được.
    const isPartial = latest && session.rounds === undefined &&
      (session.liveBalance !== undefined || session.note !== undefined);
    if (isPartial) {
      session = Object.assign({}, latest, session);
    }
    latest = session;
    el.rounds.textContent = fmtNum(session.rounds);
    el.wins.textContent = fmtNum(session.wins);
    el.losses.textContent = fmtNum(session.losses);
    el.streak.textContent = fmtNum(session.currentLossStreak);
    el.maxStreak.textContent = fmtNum(session.maxLossStreak);
    el.profit.textContent = fmtProfit(session.profit);
    el.profit.className = 'v ' + (session.profit > 0 ? 'good' : (session.profit < 0 ? 'bad' : ''));
    if (el.note && session.note !== undefined) el.note.textContent = session.note;
    el.curBet.textContent = session.currentLevel == null ? '—' : fmtNum(session.currentLevel);
    // Đồng bộ ô nhập mức gốc CHỈ khi ô bị khóa (phiên đang chạy) hoặc người dùng
    // chưa từng tự gõ — ô đang mở thì giữ nguyên giá trị người dùng nhập.
    if (el.order && session.baseLevel != null && (el.order.disabled || !betTouched) && document.activeElement !== el.order) {
      const vOrder = String(Math.round(Number(session.baseLevel) * 100) / 100);
      if (el.order.value !== vOrder) el.order.value = vOrder;
    }
    const hb = session.history && session.history.length ? session.history[session.history.length - 1] : null;
    const liveBal = (typeof session.liveBalance === 'number' && isFinite(session.liveBalance))
      ? session.liveBalance
      : (hb ? hb.balance : session.baseBalance);
    el.balance.textContent = liveBal == null ? '—' : fmtNum(liveBal);
    el.baseBal.textContent = session.baseBalance == null ? '—' : fmtNum(session.baseBalance);
    if (session.phase && !isPartial) setPhase(session.phase);
  }

  // ---------- xuất CSV ----------
  function exportCsv() {
    const s = latest;
    const rows = (s && s.history) ? s.history : [];
    const head = ['Thời gian', 'Lệnh', 'Bên', 'Kết quả', 'Chi trả', 'Số dư', 'Chuỗi thua sau'];
    const lines = [head.join(',')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      lines.push([
        new Date(r.t || Date.now()).toISOString(),
        r.order != null ? (Math.round(r.order * 100) / 100) : '',
        r.side != null ? r.side : '',
        r.result != null ? r.result : '',
        r.payout != null ? (Math.round(r.payout * 100) / 100) : '',
        r.balance != null ? (Math.round(r.balance * 100) / 100) : '',
        r.streakAfter != null ? Math.round(r.streakAfter) : ''
      ].join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = 'martingale-game-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
      '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.csv';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 500);
  }

  // ---------- modal tổng kết ----------
  function showSummary(session) {
    if (!session || !el.sum) return;
    latest = session;
    const key = [session.rounds, session.wins, session.losses, session.maxLossStreak,
      session.profit, session.baseBalance].join('|');
    // poll storage chạy mỗi giây → chống mở lại modal tổng kết trùng lặp
    if (key === lastSummaryKey && el.sumback && el.sumback.classList.contains('show')) return;
    lastSummaryKey = key;
    const profit = Math.round((Number(session.profit) || 0) * 100) / 100;
    const bal = session.history && session.history.length
      ? session.history[session.history.length - 1].balance
      : session.baseBalance;
    const d = new Date();
    el.sum.innerHTML =
      '<h2>' + (profit >= 0 ? '🎯 Phiên kết thúc — LỜI' : '🛑 Phiên kết thúc — LỖ') + '</h2>' +
      '<div class="sub">Dừng theo mốc an toàn ≤ 30% · ' + fmtClock(d.getTime()) + '</div>' +
      '<div class="grid">' +
      cellS('Vòng', fmtNum(session.rounds)) +
      cellS('Thắng', fmtNum(session.wins), 'good') +
      cellS('Thua', fmtNum(session.losses), 'bad') +
      cellS('Chuỗi thua dài nhất', fmtNum(session.maxLossStreak), 'warn') +
      cellS('Mốc gốc', session.baseBalance == null ? '—' : fmtNum(session.baseBalance)) +
      cellS('Số dư cuối', bal == null ? '—' : fmtNum(bal)) +
      cellS('Lời / Lỗ', fmtProfit(profit), profit >= 0 ? 'good' : 'bad') +
      cellS('Mức lệnh gốc', fmtNum(session.baseLevel)) +
      '</div>' +
      '<button type="button" id="mg-sum-close">Đóng — bắt đầu phiên mới khi sẵn sàng</button>';
    const closeBtn = el.sum.querySelector('#mg-sum-close');
    if (closeBtn) closeBtn.addEventListener('click', hideSummary);
    el.sumback.classList.add('show');
    function cellS(k, v, cls) {
      return '<div class="mg-cell"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>';
    }
  }

  function hideSummary() {
    if (el.sumback) el.sumback.classList.remove('show');
  }

  root.MartingaleUI = {
    mount: mount,
    update: update,
    setPhase: setPhase,
    setBlocked: setBlocked,
    setManual: setManual,
    showSummary: showSummary,
    hideSummary: hideSummary,
    exportCsv: exportCsv
  };
})();
