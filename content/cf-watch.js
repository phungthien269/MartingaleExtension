/**
 * cf-watch.js — Phát hiện trang challenge Cloudflare trên example.com.
 * Theo CONTRACT:
 *   .start()                  — bật theo dõi (polling + MutationObserver)
 *   .isBlocked() -> boolean   — trang đang bị chặn bởi challenge Cloudflare
 *   .onChange(cb(blocked, reason)) — báo mỗi lần trạng thái chặn đổi
 *
 * Tín hiệu phát hiện:
 *   1. <title> chứa "Just a moment..." / "Attention Required!" / "Please wait"
 *   2. Phần tử .cf-turnstile / [class*="cf-"] đặc trưng của challenge
 *   3. iframe có src challenges.cloudflare.com (hoặc script /cdn-cgi/challenge-platform)
 *   4. UI game biến mất liên tục quá 10 giây (site tải lại hoàn toàn)
 *
 * Trạng thái chỉ nằm trong bộ nhớ: sau khi Cloudflare reload trang, toàn bộ content
 * script chạy lại từ đầu (MartingaleMain gọi MartingaleCF.start() trước tiên), phiên lệnh
 * vẫn sống thanks MartingaleStorage — đúng yêu cầu "sống sót reload/Cloudflare".
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  const LOG = '[MartingaleCF]';

  // ---- Cấu hình ----
  const POLL_MS = 500;            // chu kỳ kiểm tra tín hiệu challenge
  const UI_GONE_BLOCK_MS = 10000; // UI game biến mất quá 10s -> coi như bị chặn
  const RESCAN_MIN_GAP_MS = 250;  // chặn co dãn MutationObserver

  // Từ khoá title đặc trưng của trang challenge Cloudflare
  const CF_TITLE_PATTERNS = [
    /just a moment/i,
    /attention required/i,
    /please wait/i,
    /checking your browser/i,
    /verify you are human/i
  ];

  // Selector đặc trưng của challenge Cloudflare
  const CF_ELEMENT_SELECTORS = [
    '.cf-turnstile',
    '[class*="cf-turnstile"]',
    '#challenge-form',
    '#challenge-running',
    '#challenge-stage',
    '#challenge-error-text',
    '.spacer[inputmode]' // khung nhập mã turnstile
  ];

  // ---- Trạng thái module ----
  let started = false;
  let stopped = false;
  let blocked = false;
  let reason = null;
  let pollTimer = null;
  let mo = null;
  let cbs = [];
  let uiGoneSince = 0;   // 0 = UI game đang thấy được
  let lastScanAt = 0;
  let scanPending = false;

  // ---- Tiện ích ----
  function log() {
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) { /* im lặng */ }
  }
  function warn() {
    try { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) { /* im lặng */ }
  }

  function safeQuerySelectorAll(sel) {
    try { return document.querySelectorAll(sel); } catch (e) { return []; }
  }

  function visible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length > 0);
  }

  // ---- Tín hiệu 1: title ----
  function detectByTitle() {
    const t = document.title || '';
    for (let i = 0; i < CF_TITLE_PATTERNS.length; i++) {
      if (CF_TITLE_PATTERNS[i].test(t)) return 'Tiêu đề trang là "' + t.trim() + '" (trang challenge Cloudflare).';
    }
    return null;
  }

  // ---- Tín hiệu 2: phần tử challenge ----
  function detectByElement() {
    for (let i = 0; i < CF_ELEMENT_SELECTORS.length; i++) {
      const els = safeQuerySelectorAll(CF_ELEMENT_SELECTORS[i]);
      for (let j = 0; j < els.length; j++) {
        if (visible(els[j]) || CF_ELEMENT_SELECTORS[i] === '.cf-turnstile') {
          return 'Phát hiện phần tử challenge Cloudflare: ' + CF_ELEMENT_SELECTORS[i] + '.';
        }
      }
    }
    return null;
  }

  // ---- Tín hiệu 3: iframe / script challenge ----
  function detectByIframe() {
    const frames = safeQuerySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      const src = frames[i].getAttribute && frames[i].getAttribute('src');
      if (src && /challenges\.cloudflare\.com/i.test(src)) {
        return 'Phát hiện iframe Cloudflare challenge (challenges.cloudflare.com).';
      }
    }
    // challenge-platform script chèn trực tiếp vào trang (không qua iframe)
    const scripts = safeQuerySelectorAll('script[src*="/cdn-cgi/challenge-platform/"]');
    if (scripts.length > 0) {
      return 'Phát hiện script challenge-platform của Cloudflare (/cdn-cgi/challenge-platform/).';
    }
    return null;
  }

  // ---- Tín hiệu 4: UI game biến mất quá 10s ----
  // LƯU Ý: script challenge-platform "jsd" (session detection) luôn hiện trên site
  // bình thường KHÔNG tính là bị chặn — chỉ challenge thật (title/turnstile/iframe) mới chặn.
  function isPanelUiPresent() {
    if (!document.body || !document.getElementById('app')) return false;
    const probes = [
      '[data-testid="wheel-container"]',
      '[data-testid="order-button-t"]',
      '[data-testid="order-button-ct"]',
      '[data-testid="game-amount-input"]',
      '.order-btn',
      '[data-testid="balance"]'
    ];
    for (let i = 0; i < probes.length; i++) {
      const els = safeQuerySelectorAll(probes[i]);
      for (let j = 0; j < els.length; j++) {
        if (visible(els[j])) return true;
      }
    }
    return false;
  }

  function detectByUiGone(now) {
    if (isPanelUiPresent()) {
      uiGoneSince = 0;
      return null;
    }
    if (!uiGoneSince) uiGoneSince = now;
    const goneFor = now - uiGoneSince;
    if (goneFor >= UI_GONE_BLOCK_MS) {
      return 'Giao diện game biến mất ' + Math.round(goneFor / 1000) + ' giây (có thể do challenge Cloudflare hoặc lỗi tải trang).';
    }
    return null;
  }

  // ---- Vòng quét ----
  function scan() {
    if (stopped) return;
    lastScanAt = Date.now();
    scanPending = false;

    const now = Date.now();
    let hit =
      detectByTitle() ||
      detectByIframe() ||
      detectByElement() ||
      detectByUiGone(now);

    if (hit && !blocked) {
      blocked = true;
      reason = hit;
      warn('BỊ CHẶN — ' + hit);
      fire();
    } else if (!hit && blocked) {
      blocked = false;
      const oldReason = reason;
      reason = null;
      log('Hết chặn (trước đó: ' + oldReason + ') — trang game hoạt động lại bình thường.');
      fire();
    } else if (hit) {
      reason = hit; // cập nhật lý do mới nhất (ví dụ đếm giây UI biến mất)
    }
  }

  function scheduleScan() {
    if (scanPending || stopped) return;
    const gap = RESCAN_MIN_GAP_MS - (Date.now() - lastScanAt);
    scanPending = true;
    setTimeout(scan, gap > 0 ? gap : 0);
  }

  function fire() {
    cbs.slice().forEach((cb) => {
      try { cb(blocked, reason); } catch (e) { warn('onChange callback lỗi:', e && e.message); }
    });
  }

  // ---- API công khai ----

  /** Bật theo dõi Cloudflare (idempotent — gọi nhiều lần không tạo bộ theo dõi mới). */
  function start() {
    if (started) {
      log('start() gọi lại — bộ theo dõi Cloudflare đã chạy, bỏ qua.');
      return;
    }
    started = true;
    stopped = false;

    scan();
    pollTimer = setInterval(scan, POLL_MS);

    const observeBody = () => {
      if (mo || !document.body) return;
      mo = new MutationObserver(scheduleScan);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      log('Đã bật canh challenge Cloudflare: poll ' + POLL_MS + 'ms + MutationObserver.');
    };
    observeBody();
    document.addEventListener('DOMContentLoaded', observeBody);
  }

  /** true khi trang đang bị challenge Cloudflare chặn. */
  function isBlocked() {
    return blocked;
  }

  /** Lý do chặn hiện tại (null nếu không bị chặn) — tiện cho UI banner. */
  function getReason() {
    return reason;
  }

  /** Đăng ký callback(blocked, reason) — gọi ngay 1 lần với trạng thái hiện tại. */
  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    cbs.push(cb);
    try { cb(blocked, reason); } catch (e) { /* bỏ qua */ }
    return function unsubscribe() {
      cbs = cbs.filter((c) => c !== cb);
    };
  }

  /** Dừng theo dõi (khi gỡ panel hoặc rời trang). */
  function stop() {
    stopped = true;
    started = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (mo) { mo.disconnect(); mo = null; }
    log('Đã dừng canh Cloudflare.');
  }

  root.MartingaleCF = { start, stop, isBlocked, getReason, onChange };
})();
