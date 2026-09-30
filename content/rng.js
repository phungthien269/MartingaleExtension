/**
 * rng.js — Nguồn ngẫu nhiên mã hóa thuần (bất biến nghiệp vụ #9).
 * Không dùng Math.random cho bất kỳ quyết định lệnh nào.
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  function randUint32() {
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
      throw new Error('crypto.getRandomValues không khả dụng — môi trường không an toàn');
    }
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  }

  /**
   * Chọn bên lệnh: 0 = T, 1 = CT. Mỗi vòng độc lập hoàn toàn.
   * theo spec: crypto.getRandomValues(new Uint32Array(1))[0] % 2
   */
  function pickSide() {
    return randUint32() % 2;
  }

  const SIDE_NAMES = { 0: 'T', 1: 'CT' };

  function sideName(idx) {
    return SIDE_NAMES[idx] || String(idx);
  }

  root.MartingaleRNG = { randUint32, pickSide, sideName, SIDE_NAMES };
})();
