/**
 * dom.js — Bộ bám DOM cho example.com/game.
 * Theo dõi: số dư (coin), nút lệnh T/CT (+ DICE để CHẶN), kết quả các vòng quay.
 *
 * Bộ selector chuẩn hóa theo cấu trúc DOM của bảng điều khiển trực tuyến (đã tổng quát hóa).
 *   - Số dư:      [data-testid="balance"], #total-balance, .balance, .balance__button
 *   - Nút lệnh:   [data-testid="order-button-t" | "order-button-ct" | "order-button-bonus"],
 *                 .order-btn, .order-btn--t, .order-btn--ct, .order-btn--bonus,
 *                 .order-btn--placed, .order-btn--disabled, .order-btn--rolling
 *   - Mức lệnh:   [data-testid="game-amount-input"], nút nhanh [data-testid="game-amount-input-<mức>"]
 *   - Kết quả:    [data-testid="previous-rolls-item"], class con .coin-t / .coin-ct / .coin-bonus (có thể kèm "-halloween")
 *   - Bàn quay:   [data-testid="wheel-container"], [data-testid="countdown-time"], .orders-container--rolling
 *
 * Quy tắc bắt buộc:
 *   - placeOrder chỉ nhận 'T' | 'CT'. Bất kỳ bên nào khác (DICE/BONUS...) bị TỪ CHỐI ở tầng
 *     logic bằng promise reject, TRƯỚC KHI đụng tới DOM.
 *   - Không bám được số dư trên DOM -> chuyển chế độ MANUAL và báo qua onManualBalance;
 *     người dùng nhập số dư tay bằng setManualBalance(), getBalance() trả về giá trị đó.
 *   - Tiền là số thập phân tối đa 2 chữ số (mọi giá trị đọc/ghi được làm tròn 2 chữ số).
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  const LOG = '[MartingaleDOM]';

  // ---- Cấu hình ----
  const DEFAULT_POLL_MS = 1000;      // chu kỳ quét lại định kỳ
  const RESCAN_MIN_GAP_MS = 250;     // chặn co dãn MutationObserver
  const MANUAL_FAST_SCANS = 5;       // mất bám số dư N lần liên tiếp khi có UI game -> MANUAL
  const MANUAL_SLOW_SCANS = 30;      // mất bám hoàn toàn N lần liên tiếp -> MANUAL (site có thể đổi giao diện)
  const PLACE_VERIFY_MS = 2500;      // thời gian tối đa xác nhận lệnh
  const PLACE_VERIFY_STEP_MS = 150;

  // ---- Selector đa tầng (mỗi nhóm có nhiều fallback, ưu tiên data-testid thật) ----
  const SEL = {
    balance: [
      '[data-testid="balance"] > span',
      '#total-balance',
      '[data-testid="balance"]',
      '.balance:not(.balance__button)',
      '[id*="total-balance"]',
      '[class*="balance"]:not([class*="balance__button"]):not([class*="text-balance"])'
    ],
    sideButton: {
      t: [
        '[data-testid="order-button-t"]',
        'button.order-btn.order-btn--t',
        '.order-btn--t'
      ],
      ct: [
        '[data-testid="order-button-ct"]',
        'button.order-btn.order-btn--ct',
        '.order-btn--ct'
      ],
      bonus: [ // DICE — chỉ để nhận diện, placeOrder luôn từ chối bên này
        '[data-testid="order-button-bonus"]',
        '.order-btn--bonus'
      ]
    },
    results: [
      '[data-testid="previous-rolls-item"]',
      '.previous-rolls-item',
      '[class*="previous-rolls"] > div'
    ],
    wheel: [
      '[data-testid="wheel-container"]',
      '.wheel[data-testid], .wheel'
    ],
    rolling: [
      '[data-testid="rolling-state"]',
      '.orders-container--rolling',
      '.order-btn--rolling'
    ],
    betInput: [
      '[data-testid="game-amount-input"]',
      '[class*="game-amount-input"] input',
      'input[type="text"][placeholder*="order" i]'
    ]
  };

  // ---- Trạng thái module ----
  let inited = false;
  let stopped = false;
  let pollMs = DEFAULT_POLL_MS;
  let pollTimer = null;
  let mo = null;
  let mode = 'AUTO'; // 'AUTO' | 'MANUAL'
  let manualBalance = null;
  let balanceMissStreak = 0;
  let lastBalance = null; // số dư AUTO gần nhất từng đọc được (phòng hờ đọc lỗi thoáng qua)
  let manualCbs = [];
  let lastScanAt = 0;
  let scanPending = false;

  // ---- Tiện ích ----
  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) { /* im lặng */ }
  }
  function warn() {
    try { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) { /* im lặng */ }
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function visible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length > 0);
  }

  /**
   * Tìm phần tử theo danh sách selector nhiều tầng.
   * opts = { requireVisible: boolean (mặc định true) }
   */
  function findIn(sels, opts) {
    const o = opts || {};
    let firstAny = null;
    for (let i = 0; i < sels.length; i++) {
      let els;
      try { els = document.querySelectorAll(sels[i]); } catch (e) { continue; } // selector lỗi -> bỏ qua tầng này
      for (let j = 0; j < els.length; j++) {
        const el = els[j];
        if (!firstAny) firstAny = el;
        if (visible(el)) return el;
      }
      if (o.firstMatchOnly && firstAny) return firstAny;
    }
    return o.requireVisible ? null : firstAny;
  }

  /**
   * Đọc số tiền (thập phân tối đa 2 chữ số) từ text hiển thị, dung chuẩn phân cách kiểu:
   * 12345 / 12,345 / 12.345 / 1,234.56 / 1.234,56 / "12 345 coin".
   */
  function parseCoinText(raw) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).replace(/[\s\u00a0]/g, '');
    s = s.replace(/[^0-9.,-]/g, '');
    if (!s || !/[0-9]/.test(s)) return null;
    s = s.replace(/(?!^)-/g, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
      else s = s.replace(/,/g, '');                                       // 1,234.56
    } else if (lastDot >= 0 || lastComma >= 0) {
      // CHỈ MỘT loại dấu: quyết định thập phân vs ngăn cách nghìn theo độ dài nhóm cuối.
      // Cuối cùng CHUẨN HÓA về dạng Number() đọc được: bỏ ',', giữ '.' làm thập phân.
      const lastSep = Math.max(lastDot, lastComma);
      const intPart = s.slice(0, lastSep);
      const decPart = s.slice(lastSep + 1);
      const sep = (lastDot >= lastComma) ? '.' : ',';
      if (decPart.length > 0 && decPart.length <= 2) {
        // 2.22 / 2,22 / 1234.5 -> thập phân: chuẩn hóa dấu phẩy thành chấm
        s = (sep === ',') ? (intPart + '.' + decPart) : s; // '.' đã đúng, ',' đổi
      } else {
        // 12,345 / 2.220 / 1.234.567 -> ngăn cách nghìn: bỏ hết dấu
        s = s.replace(/[.,]/g, '');
      }
    }
    const n = Number(s);
    if (!isFinite(n)) return null;
    return Math.round(n * 100) / 100; // tiền là số thập phân tối đa 2 chữ số
  }

  // ---- Số dư ----
  function readBalanceFromDom() {
    for (let i = 0; i < SEL.balance.length; i++) {
      let els;
      try { els = document.querySelectorAll(SEL.balance[i]); } catch (e) { continue; }
      for (let j = 0; j < els.length; j++) {
        if (!visible(els[j])) continue;
        const n = parseCoinText(els[j].textContent);
        if (n !== null) return n;
      }
    }
    return null;
  }

  // ---- Nút lệnh ----
  function findBetButton(kind) {
    return findIn(SEL.sideButton[kind] || [], { requireVisible: false });
  }

  // ---- Kết quả các vòng ----
  // DOM "previous-rolls" theo thứ tự CŨ -> MỚI (store push vào cuối mảng),
  // classifyRoll đọc class con .coin-t / .coin-ct / .coin-bonus (kể cả -halloween).
  function classifyRoll(el) {
    if (!el) return null;
    const scope = /coin-/.test(el.className || '') ? el : (el.querySelector('[class*="coin-"]') || el);
    const cls = String(scope.className || '');
    if (/coin-bonus/.test(cls)) return 'DICE';
    if (/coin-ct/.test(cls)) return 'CT';
    if (/coin-t/.test(cls)) return 'T';
    return null;
  }

  // ---- Quét định kỳ + chuyển chế độ MANUAL ----
  function rescan() {
    lastScanAt = Date.now();
    scanPending = false;

    const bal = readBalanceFromDom();
    if (bal !== null) {
      balanceMissStreak = 0;
      lastBalance = bal;
      if (mode !== 'AUTO') {
        mode = 'AUTO';
        manualBalance = null;
        log('Bám lại được số dư trên DOM — tắt chế độ MANUAL.');
        fireManual(null);
      }
      return;
    }

    balanceMissStreak++;
    const hasPanelUi = !!(findBetButton('t') || findBetButton('ct') || findIn(SEL.wheel, { requireVisible: false }));
    const trigger = balanceMissStreak >= MANUAL_FAST_SCANS && hasPanelUi
      ? 'fast'
      : (balanceMissStreak >= MANUAL_SLOW_SCANS ? 'slow' : null);
    if (trigger && mode !== 'MANUAL') {
      mode = 'MANUAL';
      const reason = trigger === 'fast'
        ? 'Không đọc được số dư trên DOM dù giao diện game đã hiện (site đổi markup hoặc chưa đăng nhập). Hãy nhập số dư tay trên bảng điều khiển.'
        : 'Không bám được DOM game sau ' + balanceMissStreak + ' lần quét. Hãy nhập số dư tay trên bảng điều khiển; lệnh tự động sẽ dừng cho tới khi DOM bám lại được.';
      warn('Chuyển chế độ MANUAL — ' + reason);
      fireManual(reason);
    }
  }

  function scheduleRescan() {
    if (scanPending || stopped) return;
    const gap = RESCAN_MIN_GAP_MS - (Date.now() - lastScanAt);
    scanPending = true;
    setTimeout(rescan, gap > 0 ? gap : 0);
  }

  function fireManual(reason) {
    manualCbs.slice().forEach((cb) => {
      try { cb(reason); } catch (e) { warn('onManualBalance callback lỗi:', e && e.message); }
    });
  }

  // ---- API công khai ----

  /** Bật theo dõi: polling + MutationObserver, tự quét lại selector khi DOM đổi. */
  function init(opts) {
    const o = opts || {};
    const p = Math.round(Number(o.pollMs));
    pollMs = isFinite(p) && p >= 200 ? Math.min(p, 60000) : DEFAULT_POLL_MS;

    if (inited) {
      log('init() gọi lại — giữ nguyên bộ theo dõi hiện có (pollMs=' + pollMs + 'ms).');
      return;
    }
    inited = true;
    stopped = false;

    rescan();
    pollTimer = setInterval(rescan, pollMs);

    const observeBody = () => {
      if (mo || !document.body) return;
      mo = new MutationObserver(scheduleRescan);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-testid'] });
      log('Đã bật bám DOM game: poll ' + pollMs + 'ms + MutationObserver.');
    };
    observeBody();
    document.addEventListener('DOMContentLoaded', observeBody);
  }

  /** Số dư hiện tại (số thập phân tối đa 2 chữ số) hoặc null nếu chưa biết. */
  function getBalance() {
    if (mode === 'MANUAL') return manualBalance;
    const bal = readBalanceFromDom();
    if (bal !== null) {
      balanceMissStreak = 0;
      lastBalance = bal;
      return bal;
    }
    return lastBalance; // null nếu chưa từng đọc được
  }

  /** Nút lệnh hiện tại: { t, ct, dice } — dice chỉ để nhận diện, placeOrder luôn từ chối. */
  function getControls() {
    return {
      t: findBetButton('t'),
      ct: findBetButton('ct'),
      dice: findBetButton('bonus')
    };
  }

  /** UI game đã sẵn sàng để đặt lệnh chưa (đủ nút T+CT và biết số dư). */
  function isUiReady() {
    if (typeof document === 'undefined' || !document.body || !document.getElementById('app')) return false;
    const t = findBetButton('t');
    const ct = findBetButton('ct');
    if (!t || !ct) return false;
    const balanceKnown = mode === 'MANUAL' ? manualBalance !== null : readBalanceFromDom() !== null;
    return balanceKnown;
  }

  /**
   * Đặt lệnh vào một bên. CHỈ chấp nhận 'T' | 'CT' — DICE bị chặn ở tầng logic.
   * @returns Promise<{ok:boolean, reason?:string}>
   *   - Bên không hợp lệ (DICE...) -> promise REJECT (Error, code='DICE_BLOCKED').
   *   - Lỗi vận hành (thiếu nút, nút bị khoá...) -> resolve {ok:false, reason}.
   */
  function placeOrder(side, amount) {
    const s = String(side === null || side === undefined ? '' : side).trim().toUpperCase();
    if (s !== 'T' && s !== 'CT') {
      warn('TỪ CHỐI lệnh bên "' + side + '" — chỉ cho phép T hoặc CT (DICE/bonus bị cấm theo quy tắc Martingale T/CT).');
      const err = new Error('MartingaleDOM: bên lệnh "' + side + '" không được phép — chỉ T hoặc CT (DICE bị chặn).');
      err.code = 'DICE_BLOCKED';
      return Promise.reject(err);
    }

    const amt = Math.round(Number(amount) * 100) / 100;
    return new Promise(async (resolve) => {
      if (!isFinite(amt) || amt <= 0) {
        resolve({ ok: false, reason: 'MỨC_LỆNH_KHÔNG_HỢP_LỆ' });
        return;
      }
      if (!isUiReady()) {
        resolve({ ok: false, reason: 'UI_CHƯA_SẴN_SÀNG' });
        return;
      }

      const controls = getControls();
      const btn = s === 'T' ? controls.t : controls.ct;
      if (!btn) {
        warn('Không tìm thấy nút lệnh ' + s + ' trên DOM — bỏ lệnh.');
        resolve({ ok: false, reason: 'KHÔNG_TÌM_THẤY_NÚT_LỆNH' });
        return;
      }
      if (btn.disabled || /order-btn--disabled|order-btn--rolling/.test(btn.className || '')) {
        resolve({ ok: false, reason: 'NÚT_LỆNH_BỊ_KHOÁ' });
        return;
      }

      if (!setBetAmount(amt)) {
        resolve({ ok: false, reason: 'KHÔNG_NHẬP_ĐƯỢC_MỨC_LỆNH' });
        return;
      }

      btn.click();
      log('Đã bấm lệnh ' + s + ' với ' + amt + ' coin, chờ xác nhận...');

      const placed = await verifyPlaced(btn);
      if (placed) {
        log('Lệnh ' + s + ' (' + amt + ' coin) đã được ghi nhận trên bàn.');
        resolve({ ok: true });
      } else {
        warn('Không xác nhận được lệnh ' + s + ' sau ' + PLACE_VERIFY_MS + 'ms (có thể vẫn đã vào bàn).');
        resolve({ ok: false, reason: 'KHÔNG_XÁC_NHẬN_ĐƯỢC_LỆNH' });
      }
    });
  }

  /** Nhập mức lệnh vào ô input (Vue) hoặc bấm nút nhanh khớp mức. */
  function setBetAmount(amount) {
    let viaQuick = false;
    try {
      const quick = document.querySelector('[data-testid="game-amount-input-' + amount + '"]');
      if (quick) { quick.click(); viaQuick = true; }
    } catch (e) { /* bỏ qua */ }

    let input = null;
    for (let i = 0; i < SEL.betInput.length && !input; i++) {
      let els;
      try { els = document.querySelectorAll(SEL.betInput[i]); } catch (e) { continue; }
      for (let j = 0; j < els.length; j++) {
        const el = els[j];
        if (el.tagName === 'INPUT') { input = el; break; }
        const inner = el.querySelector && el.querySelector('input');
        if (inner) { input = inner; break; }
      }
    }
    if (!input) return viaQuick;

    try {
      input.focus();
      const desc = Object.getOwnPropertyDescriptor(root.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(input, String(amount));
      else input.value = String(amount);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      warn('Không set được ô mức lệnh:', e && e.message);
      return viaQuick;
    }
  }

  /** Xác nhận lệnh đã vào bàn (nút --placed hoặc có lệnh pending). */
  async function verifyPlaced(btn) {
    const deadline = Date.now() + PLACE_VERIFY_MS;
    while (Date.now() < deadline) {
      await sleep(PLACE_VERIFY_STEP_MS);
      if (/order-btn--placed/.test(btn.className || '')) return true;
      if (document.querySelector('.order--pending, .order-btn--placed')) return true;
    }
    return false;
  }

  /**
   * Kết quả các vòng quay, MỚI NHẤT ĐẦU TIÊN: 'T' | 'CT' | 'DICE'.
   * getResults(n) -> tối đa n phần tử; getResults() -> toàn bộ lịch sử thấy được.
   */
  function getResults(n) {
    const els = [];
    for (let i = 0; i < SEL.results.length && els.length === 0; i++) {
      let found;
      try { found = document.querySelectorAll(SEL.results[i]); } catch (e) { continue; }
      for (let j = 0; j < found.length; j++) els.push(found[j]);
    }
    const list = [];
    for (let i = 0; i < els.length; i++) {
      const r = classifyRoll(els[i]);
      if (r) list.push(r);
    }
    list.reverse(); // DOM cũ -> mới; hợp đồng yêu cầu mới nhất đầu tiên
    if (typeof n === 'number' && isFinite(n)) return list.slice(0, Math.max(0, Math.round(n)));
    return list;
  }

  /** Đăng ký callback khi mất bám số dư trên DOM (bật MANUAL) / bám lại (reason=null). */
  function onManualBalance(cb) {
    if (typeof cb !== 'function') return function () {};
    manualCbs.push(cb);
    if (mode === 'MANUAL') {
      try { cb('ĐANG ở chế độ MANUAL — không đọc được số dư trên DOM.'); } catch (e) { /* bỏ qua */ }
    }
    return function unsubscribe() {
      manualCbs = manualCbs.filter((c) => c !== cb);
    };
  }

  /** UI gọi khi người dùng nhập số dư tay (chế độ MANUAL). */
  function setManualBalance(value) {
    const n = Math.round(Number(value) * 100) / 100;
    if (!isFinite(n) || n < 0) {
      warn('setManualBalance: giá trị không hợp lệ:', value);
      return false;
    }
    manualBalance = n;
    mode = 'MANUAL';
    log('Người dùng nhập số dư tay: ' + n + ' coin.');
    return true;
  }

  /** 'AUTO' (đang bám DOM) hoặc 'MANUAL' (người dùng nhập tay). */
  function getMode() { return mode; }

  /** Dừng toàn bộ theo dõi (dùng khi gỡ panel/đi ra khỏi trang). */
  function stop() {
    stopped = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (mo) { mo.disconnect(); mo = null; }
    inited = false;
    log('Đã dừng bám DOM.');
  }

  root.MartingaleDOM = {
    init,
    getBalance,
    getControls,
    placeOrder,
    isUiReady,
    getResults,
    onManualBalance,
    setManualBalance,
    getMode,
    stop
  };
})();
