/**
 * storage.js — Persistence qua chrome.storage.local (nghiệp vụ #8).
 * Phiên lệnh phải sống sót qua reload trang (kể cả reload do Cloudflare).
 *
 * Có shim fallback khi chrome.storage không tồn tại (trang mock test chạy file://
 * hoặc localhost không có extension): dùng localStorage + cùng API Promise.
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  const KEY = 'martingaleSessionState.v1';

  const hasChromeStorage =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  // ---- shim localStorage (mock) ----
  const localShim = {
    async get(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
      } catch (e) {
        return undefined;
      }
    },
    async set(obj) {
      for (const k of Object.keys(obj)) {
        localStorage.setItem(k, JSON.stringify(obj[k]));
      }
    },
    async remove(keys) {
      for (const k of [].concat(keys)) localStorage.removeItem(k);
    }
  };

  const chromeWrap = {
    async get(key) {
      return new Promise((resolve) => {
        chrome.storage.local.get(key, (res) => resolve(res && res[key]));
      });
    },
    async set(obj) {
      return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
    },
    async remove(keys) {
      return new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
    }
  };

  const backend = hasChromeStorage ? chromeWrap : localShim;

  const DEFAULT_SESSION = {
    // cấu hình
    baseLevel: 100,
    // trạng thái máy
    phase: 'IDLE', // IDLE | RUNNING | PAUSED | BLOCKED | ENDED
    wasRunningBeforeBlock: false,
    baseBalance: null, // mốc gốc (số dư lúc bấm Bắt đầu phiên)
    currentLevel: null, // mức lệnh hiện tại (null = chưa vào phiên)
    orderPlaced: false, // đã đặt lệnh cho vòng hiện tại chưa
    // thống kê
    rounds: 0,
    wins: 0,
    losses: 0,
    currentLossStreak: 0,
    maxLossStreak: 0,
    profit: 0, // >0 lời, <0 lỗ
    // dữ liệu
    history: [], // {t, order, side, result, payout, balance, streakAfter}
    chart: [] // {t, balance} điểm biểu đồ
  };

  function defaultSession() {
    return JSON.parse(JSON.stringify(DEFAULT_SESSION));
  }

  async function load() {
    const data = await backend.get(KEY);
    if (!data || typeof data !== 'object') return null;
    // hợp nhất với default để không vỡ khi upgrade schema
    const merged = Object.assign(defaultSession(), data);
    if (!Array.isArray(merged.history)) merged.history = [];
    if (!Array.isArray(merged.chart)) merged.chart = [];
    return merged;
  }

  async function save(session) {
    await backend.set({ [KEY]: session });
  }

  async function clear() {
    await backend.remove(KEY);
  }

  root.MartingaleStorage = {
    KEY,
    DEFAULT_SESSION,
    defaultSession,
    load,
    save,
    clear,
    hasChromeStorage
  };
})();
