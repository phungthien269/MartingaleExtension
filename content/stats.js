/**
 * stats.js — Thống kê & tính mức lệnh của Martingale Extension Dashboard.
 * Module THUẦN: không đụng DOM, không storage, không timer — chỉ biến đổi session.
 *
 * Nghiệp vụ (CONTRACT + luật bất biến):
 *  - Tiền: số thập phân tối đa 2 chữ số (helper round2) — site cho lệnh lẻ 0.01.
 *  - nextLevel:  chưa có vòng nào  -> baseLevel
 *              vòng trước THẮNG -> baseLevel
 *              vòng trước THUA  -> currentLevel * 2 (số nguyên, không cap số lần x2)
 *  - shouldStop: số dư <= round2(baseBalance * 0.3)  (mốc dừng 30%)
 *                hoặc số dư < currentLevel (không đủ tiền cho vòng kế tiếp).
 *  - Kết quả 'DICE' (ô x14): với lệnh T hoặc CT luôn được tính là THUA.
 *    Engine không bao giờ đặt lệnh DICE — stats chỉ phân loại kết quả.
 *
 * Quy ước dữ liệu (dùng chung với engine.js):
 *  - session.history: mảng theo thứ tự CŨ -> MỚI (push vào cuối).
 *    Mỗi dòng: { t, order, side, result, payout, balance, streakAfter }.
 *  - payout là LÃI/LỖ RÒNG của vòng: thắng = +order, thua = -order.
 *    => session.profit = tổng payout (dương lời, âm lỗ).
 *  - Nếu caller không truyền payout, recordRound tự suy ra từ win/lose.
 *
 * API: MartingaleStats.lastRound(session), lastBalance(session),
 *      recordRound(session, {order,side,result,payout,balance}) -> session,
 *      nextLevel(session) -> number,
 *      shouldStop(session[, liveBalance]) -> {stop, reason}
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  /** Làm tròn tiền 2 chữ số thập phân (site cho lệnh lẻ 0.01). */
  function round2(x) {
    return Math.round(Number(x) * 100) / 100;
  }

  /** Vòng gần nhất (cũ -> mới nên phần tử cuối là mới nhất), hoặc null. */
  function lastRound(session) {
    if (!session || !Array.isArray(session.history) || session.history.length === 0) return null;
    return session.history[session.history.length - 1];
  }

  /** Số dư mới nhất biết được trong session: vòng gần nhất, rồi tới mốc gốc. */
  function lastBalance(session) {
    const last = lastRound(session);
    if (last && typeof last.balance === 'number' && isFinite(last.balance)) return last.balance;
    if (session && typeof session.baseBalance === 'number' && isFinite(session.baseBalance)) {
      return session.baseBalance;
    }
    return null;
  }

  /**
   * Ghi một vòng vào session (mutation tại chỗ, trả về chính session).
   * round = { order, side: 'T'|'CT', result: 'T'|'CT'|'DICE', payout?, balance? }
   */
  function recordRound(session, round) {
    if (!session) return session;
    const r = round || {};

    const order = Math.max(0, round2(Number(r.order) || 0));
    const side = r.side === 'CT' ? 'CT' : 'T';
    const result = (r.result === 'T' || r.result === 'CT' || r.result === 'DICE') ? r.result : 'DICE';
    const win = result === side; // 'DICE' -> luôn thua với lệnh T/CT
    const payout = (typeof r.payout === 'number' && isFinite(r.payout))
      ? round2(r.payout)
      : (win ? order : -order);
    const balance = (typeof r.balance === 'number' && isFinite(r.balance)) ? round2(r.balance) : null;

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
      t: Date.now(),
      order: order,
      side: side,
      result: result,
      payout: payout,
      balance: balance,
      streakAfter: session.currentLossStreak
    });
    return session;
  }

  /**
   * Mức lệnh cho vòng kế tiếp (số nguyên):
   *  - chưa có vòng nào        -> baseLevel
   *  - vòng trước thắng        -> baseLevel
   *  - vòng trước thua         -> currentLevel * 2
   */
  function nextLevel(session) {
    const s = session || {};
    const base = Math.max(0.01, round2(Number(s.baseLevel)) || 0.01);
    const last = lastRound(s);
    if (!last) return base; // chưa có vòng nào trong phiên
    const won = last.result === last.side || (typeof last.payout === 'number' && last.payout > 0);
    if (won) return base;
    // X2 trên mức ĐÃ CHƠI THỰC TẾ của vòng cuối (last.order), KHÔNG dùng s.currentLevel:
    // currentLevel bị engine ghi đè thành mức mới ngay khi bắt đầu đặt — kể cả khi đặt
    // THẤT BẠI (nút khoá khi đang quay) — dùng nó sẽ nhân đôi lặp lại mỗi lần retry (x4, x8...).
    const cur = Math.max(0.01, round2(Number(last.order) || base));
    return round2(cur * 2);
  }

  /**
   * Điều kiện dừng phiên:
   *  - số dư <= 30% mốc gốc (round2(baseBalance * 0.3)), HOẶC
   *  - số dư < currentLevel (không đủ tiền cho vòng kế tiếp).
   * liveBalance (tùy chọn, cho engine truyền số dư DOM/nhập tay mới nhất);
   * bỏ qua thì dùng balance của vòng gần nhất, rồi tới baseBalance.
   * Trả về { stop: boolean, reason: string|null } — reason là text tiếng Việt.
   */
  function shouldStop(session, liveBalance) {
    const s = session || {};
    const bal = (typeof liveBalance === 'number' && isFinite(liveBalance))
      ? round2(liveBalance)
      : lastBalance(s);

    if (typeof s.baseBalance === 'number' && isFinite(s.baseBalance) && bal != null) {
      const milestone = round2(s.baseBalance * 0.3);
      if (bal <= milestone) {
        return {
          stop: true,
          reason: 'Số dư ' + bal + ' đã chạm mốc dừng ≤30% mốc gốc (' + milestone + ') — tự dừng để bảo toàn vốn.'
        };
      }
    }
    if (typeof s.currentLevel === 'number' && s.currentLevel > 0 && bal != null && bal < s.currentLevel) {
      return {
        stop: true,
        reason: 'Số dư ' + bal + ' không đủ cho mức lệnh kế tiếp (' + s.currentLevel + ').'
      };
    }
    return { stop: false, reason: null };
  }

  root.MartingaleStats = {
    lastRound: lastRound,
    lastBalance: lastBalance,
    recordRound: recordRound,
    nextLevel: nextLevel,
    shouldStop: shouldStop
  };
})();
