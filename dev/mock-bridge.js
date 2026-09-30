/**
 * mock-bridge.js - Cau noi giua extension va trang mock.html (Agent-G).
 *
 * Quy tac TUYET DOI: file nay chi hoat dong khi window.__martingale_MOCK__ === true
 * (co do mock.html dat TRUOC khi tai content scripts). Tren site that
 * example.com co khong ton tai -> IIFE return ngay lap tuc: khong bam gi,
 * khong dung DOM, khong gan listener, khong tao bien toan cuc - no-op 100%.
 *
 * Tren trang mock, bridge:
 *  1. Nhan lenh cuoc cua engine: MartingaleDOM.placeOrder(side, amount) (adapter do
 *     bridge cung cap) -> click nut T/CT/DICE cua mock -> game mock ghi nhan
 *     (tru tien, danh dau da cuoc).
 *  2. Khi vong quay co ket qua -> MutationObserver tren danh sach ket qua mock
 *     (li[data-result]) -> cap nhat trang thai + de MartingaleDOM.getResults() quet
 *     duoc (moi nhat dau, chuan 'T'|'CT'|'DICE').
 *  3. Cap adapter MartingaleCF cho mock: "bi chan" khi overlay Cloudflare gia lap
 *     (#cf-overlay) dang hien thi.
 *
 * Adapter MartingaleDOM/MartingaleCF do bridge cung cap thay cho dom.js/cf-watch.js vi
 * hai module that nham selector vao markup example.com; API van DUNG CONTRACT.
 * Patch IN-PLACE (giu nguyen identity object vi main.js co the da giu tham chieu).
 */
(function () {
  'use strict';

  /* ===== GUARD: tren site that - no-op tuyet doi ===== */
  if (typeof window === 'undefined') return;
  if (window.__martingale_MOCK__ !== true) return;

  var root = typeof globalThis !== 'undefined' ? globalThis : window;

  var MOCK_FLAG = '__martingale_MOCK__';
  var OVERLAY_ID = 'cf-overlay';
  var RESULTS_LIST_ID = 'recent-results';
  var RESULT_ATTR = 'data-result';
  // fallback khi MartingaleMockGame khong san: doc so du truc tiep tu DOM mock
  var BALANCE_SELECTOR = '#mock-balance, [data-testid="balance"] > span, #total-balance';

  var bridge = {
    version: '1.0.0',
    mockFlag: MOCK_FLAG,
    orderPlaced: false,      // da cuoc cho vong hien tai chua (click nut mock)
    lastBetSide: null,
    lastBetAmount: null,
    lastBetAt: null,
    lastResult: null,      // ket qua vong moi nhat
    lastResultAt: null,
    startedAt: Date.now()
  };

  var resultListeners = [];
  var manualBalanceListeners = [];
  var cfListeners = [];
  var cfStarted = false;
  var cfBlockedNow = false;

  function logDbg(msg) {
    try { console.log('[mock-bridge] ' + msg); } catch (e) { /* ignore */ }
  }

  function mockGame() {
    return root.MartingaleMockGame || null;
  }

  function sideButtonEl(side) {
    var game = mockGame();
    if (game && typeof game.sideButton === 'function') {
      var el = game.sideButton(side);
      if (el) return el;
    }
    if (side === 'T') return document.getElementById('order-tn');
    if (side === 'CT') return document.getElementById('order-ct');
    if (side === 'DICE') return document.getElementById('order-dice');
    return null;
  }

  function parseBalanceText(text) {
    if (text == null) return null;
    var digits = String(text).replace(/[^0-9.-]/g, '');
    if (!digits.length) return null;
    var n = Math.round(parseFloat(digits) * 100) / 100; // tien thap phan 2 chu so
    return isNaN(n) ? null : n;
  }

  function readResultsFromDom(limit) {
    var out = [];
    var list = document.getElementById(RESULTS_LIST_ID);
    if (!list) return out;
    var items = list.querySelectorAll('li[' + RESULT_ATTR + ']');
    for (var i = 0; i < items.length && out.length < limit; i++) {
      var v = items[i].getAttribute(RESULT_ATTR);
      if (v === 'T' || v === 'CT' || v === 'DICE') out.push(v);
    }
    return out; // moi nhat dung dau (mock chen vao dau danh sach)
  }

  function flashButton(side, win) {
    var btn = sideButtonEl(side);
    if (!btn) return;
    var cls = win ? 'flash-win' : 'flash-lose';
    btn.classList.add(cls);
    setTimeout(function () { btn.classList.remove(cls); }, 900);
  }

  function fireResult(result) {
    bridge.lastResult = result;
    bridge.lastResultAt = Date.now();
    try {
      document.dispatchEvent(new CustomEvent('martingale-mock-result', { detail: { result: result } }));
    } catch (e) { /* trinh duyet cu - bo qua */ }
    for (var i = 0; i < resultListeners.length; i++) {
      try { resultListeners[i](result); } catch (e2) { /* listener loi - khong chan nguoi khac */ }
    }
  }

  function watchResults() {
    var list = document.getElementById(RESULTS_LIST_ID);
    if (!list || typeof MutationObserver === 'undefined') return;
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var v = node.getAttribute && node.getAttribute(RESULT_ATTR);
          if (v === 'T' || v === 'CT' || v === 'DICE') {
            var betSide = bridge.orderPlaced ? bridge.lastBetSide : null;
            if (betSide) flashButton(betSide, v === betSide);
            fireResult(v);
            logDbg('ket qua vong moi: ' + v);
          }
        }
      }
    });
    mo.observe(list, { childList: true, subtree: false });
  }

  /* ===== Do truoc trang thai Cloudflare cua mock (polling + hooks) ===== */
  function cfIsBlockedRaw() {
    var el = document.getElementById(OVERLAY_ID);
    if (el && !el.hidden) return true;
    if (document.body && document.body.classList &&
        document.body.classList.contains('cf-blocked')) return true;
    return false;
  }

  function pollCfState() {
    var blocked = cfIsBlockedRaw();
    if (blocked !== cfBlockedNow) {
      cfBlockedNow = blocked;
      logDbg('Cloudflare mock: ' + (blocked ? 'BAT DAU chan' : 'HET chan'));
      for (var i = 0; i < cfListeners.length; i++) {
        try { cfListeners[i](blocked, blocked ? 'mock-overlay' : 'mock-overlay-removed'); } catch (e) {}
      }
    }
  }

  /* ===== MartingaleDOM adapter cho mock — API DUNG CONTRACT =====
     init({pollMs}), getBalance(), getControls(), placeOrder(side, amount),
     isUiReady(), getResults(n), onManualBalance(cb)                  ===== */
  var domPollTimer = null;

  var MartingaleDOMMock = {
    __mock: true,

    init: function (opts) {
      var pollMs = (opts && opts.pollMs) || 1000;
      wireBetButtons();
      watchResults();
      if (domPollTimer) clearInterval(domPollTimer);
      domPollTimer = setInterval(function () {
        wireBetButtons();
        pollCfState();
      }, pollMs);
      logDbg('MartingaleDOM (mock adapter) init xong, poll ' + pollMs + 'ms');
      return true;
    },

    getBalance: function () {
      var game = mockGame();
      if (game && typeof game.getBalance === 'function') return game.getBalance();
      var el = document.querySelector(BALANCE_SELECTOR);
      return el ? parseBalanceText(el.textContent) : null;
    },

    getControls: function () {
      return {
        t: sideButtonEl('T'),
        ct: sideButtonEl('CT'),
        dice: sideButtonEl('DICE')
      };
    },

    placeOrder: function (side, amount) {
      return new Promise(function (resolve) {
        // CAM DICE o tang logic — dung nhu CONTRACT (engine khong bao gio cuoc DICE)
        if (side !== 'T' && side !== 'CT') {
          resolve({ ok: false, reason: 'SIDE_NOT_ALLOWED' });
          return;
        }
        var btn = sideButtonEl(side);
        if (!btn) { resolve({ ok: false, reason: 'NO_BUTTON' }); return; }
        // tien thap phan 2 chu so (vi du 0.01) — khong floor
        var amt = Math.round(Number(amount) * 100) / 100;
        if (!(amt > 0)) amt = 100;
        if (amt > 2147483647) { resolve({ ok: false, reason: 'AMOUNT_TOO_BIG' }); return; }
        if (cfIsBlockedRaw()) { resolve({ ok: false, reason: 'CLOUDFLARE_BLOCKED' }); return; }
        var game = mockGame();
        var before = game ? game.getBalance() : null;
        root.__mockNextBetAmount = amt;   // click handler doc muc nay
        root.__martingaleMockLastPlace = null;
        btn.click();                      // -> game mock tru tien + ghi nhan
        setTimeout(function () {
          var res = root.__martingaleMockLastPlace;
          var after = game ? game.getBalance() : null;
          var ok = !!(res && res.ok === true);
          if (!ok) {
            resolve({ ok: false, reason: (res && res.reason) || 'MOCK_REJECTED' });
            return;
          }
          if (before != null && after != null) {
            // verify muc tru thuc te vs muc yeu cau, co dung sai 0.005 cho
            // he thong tien thap phan 2 chu so (user cuoc 0.01): OK khi
            // Math.abs(expected - actual) < 0.005; vuot nguong -> BALANCE_MISMATCH
            var expected = amt;
            var actual = before - after;
            if (Math.abs(expected - actual) >= 0.005) {
              // game khong tru dung tien -> coi nhu that bai de engine khong tam cuoc
              resolve({ ok: false, reason: 'BALANCE_MISMATCH' });
              return;
            }
          }
          bridge.orderPlaced = true;
          bridge.lastBetSide = side;
          bridge.lastBetAmount = amt;
          bridge.lastBetAt = Date.now();
          resolve({ ok: true });
        }, 0);
      });
    },

    isUiReady: function () {
      return !!(sideButtonEl('T') && sideButtonEl('CT') &&
                document.getElementById(RESULTS_LIST_ID));
    },

    getResults: function (n) {
      var want = Math.max(1, n || 10);
      var out = readResultsFromDom(want);
      if (!out.length && bridge.lastResult) out = [bridge.lastResult];
      return out;
    },

    onManualBalance: function (cb) {
      if (typeof cb === 'function') manualBalanceListeners.push(cb);
      // mock khong can nhap tay; giu API de UI dang ky khong loi
    },

    onResult: function (cb) {
      if (typeof cb === 'function') resultListeners.push(cb);
    }
  };

  /* ===== MartingaleCF adapter cho mock — API DUNG CONTRACT =====
     start(), isBlocked(), onChange(cb(blocked, reason))              ===== */
  var MartingaleCFMock = {
    __mock: true,

    start: function () {
      if (cfStarted) return;
      cfStarted = true;
      pollCfState();
      setInterval(pollCfState, 500);
      // hook mo rong: game mock goi khi bat/tat overlay (neu co API)
      document.addEventListener('martingale-mock-cf', function (evt) {
        cfBlockedNow = !!(evt && evt.detail && evt.detail.blocked);
        for (var i = 0; i < cfListeners.length; i++) {
          try {
            cfListeners[i](cfBlockedNow, cfBlockedNow ? 'mock-overlay' : 'mock-overlay-removed');
          } catch (e) {}
        }
      });
      logDbg('MartingaleCF (mock adapter) start xong');
    },

    isBlocked: function () {
      pollCfState();
      return cfBlockedNow;
    },

    onChange: function (cb) {
      if (typeof cb === 'function') cfListeners.push(cb);
    }
  };

  /* ===== Dang ky adapter + trang thai bridge ra window (chi trang mock) =====
     QUAN TRONG: main.js da chay TRUOC mock-bridge (thu tu manifest) nen co the
     da giu tham chieu den object MartingaleDOM/MartingaleCF ban dau. Vi vay patch
     IN-PLACE (copy tung method vao object hien co, giu nguyen identity) thay vi
     gan object moi. Neu module that chua ton tai (chua duoc viet/tai) thi gan
     adapter lam fallback. cf-watch that van hoat dong duoc tren mock (overlay
     + .cf-turnstile duoc inject dong khi challenge) -> uu tien giu nguyen. */
  function patchInPlace(target, adapter, name) {
    if (!target || typeof target !== 'object') return adapter; // chua co -> dung adapter
    if (target.__mock) return target;                          // da patch roi
    for (var k in adapter) {
      if (Object.prototype.hasOwnProperty.call(adapter, k)) target[k] = adapter[k];
    }
    logDbg('da patch ' + name + ' in-place cho mock');
    return target;
  }

  function installAdapters() {
    root.MartingaleDOM = patchInPlace(root.MartingaleDOM, MartingaleDOMMock, 'MartingaleDOM');
    if (root.MartingaleCF && typeof root.MartingaleCF.isBlocked === 'function' &&
        typeof root.MartingaleCF.start === 'function' && typeof root.MartingaleCF.onChange === 'function') {
      logDbg('giu nguyen MartingaleCF that (hoat dong duoc tren mock)');
    } else {
      root.MartingaleCF = patchInPlace(root.MartingaleCF, MartingaleCFMock, 'MartingaleCF');
    }
    bridge.domAdapter = MartingaleDOMMock;
    bridge.cfAdapter = MartingaleCFMock;
    root.MartingaleMockBridge = bridge;
  }

  function wireBetButtons() {
    var sides = ['T', 'CT', 'DICE'];
    for (var i = 0; i < sides.length; i++) {
      (function (side) {
        var btn = sideButtonEl(side);
        if (!btn || btn.__martingaleMockWired) return;
        btn.__martingaleMockWired = true;
        btn.addEventListener('click', function () {
          var game = mockGame();
          var amt = Math.round(Number(root.__mockNextBetAmount) * 100) / 100;
          if (!(amt > 0)) amt = 100;
          var ok = false;
          var reason = null;
          if (!game || typeof game.tryPlaceBet !== 'function') {
            reason = 'NO_MOCK_GAME';
          } else {
            ok = game.tryPlaceBet(side, amt);
            if (!ok) reason = cfIsBlockedRaw() ? 'CLOUDFLARE_BLOCKED' : 'MOCK_REJECTED';
          }
          if (ok) {
            bridge.orderPlaced = true;
            bridge.lastBetSide = side;
            bridge.lastBetAmount = amt;
            bridge.lastBetAt = Date.now();
            logDbg('da cuoc ' + side + ' ' + amt + ' coin');
          } else {
            logDbg('tu choi cuoc ' + side + ' ' + amt + ' (' + reason + ')');
          }
          root.__martingaleMockLastPlace = { ok: ok, reason: reason, side: side, amount: amt };
        });
      })(sides[i]);
    }
  }

  installAdapters();
  logDbg('mock-bridge san sang (chi chay tren trang mock)');
})();
