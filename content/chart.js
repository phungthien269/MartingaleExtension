/**
 * chart.js — Biểu đồ đường số dư bằng canvas thuần (nghiệp vụ #5, Agent-F).
 *
 * API theo CONTRACT:
 *  - .mount(container) : gắn biểu đồ (thanh công cụ + canvas) vào phần tử cha
 *  - .setData(chart)   : thay toàn bộ dữ liệu [{t, balance}]
 *  - .push(point)      : thêm 1 điểm mới, tự trượt khung nhìn bám điểm mới nhất
 *  - Zoom: lăn chuột + nút ＋/－ ; Pan: kéo ngang ; Double-click / "Vừa khung": auto-fit
 *  - Grid + nhãn thời gian (giờ:phút:giây), dark mode, KHÔNG thư viện ngoài.
 */
(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined' ? globalThis : window;

  const COLOR = {
    bg: '#10141d',
    grid: 'rgba(255,255,255,0.07)',
    text: '#8b93a7',
    line: '#4da3ff',
    fill: 'rgba(77,163,255,0.10)',
    dot: '#ffd166'
  };

  const PAD = { top: 12, right: 58, bottom: 24, left: 10 };
  const MIN_SPAN_MS = 5000; // không cho zoom sát hơn 5 giây
  const MAX_POINTS = 20000; // trần điểm vẽ để giữ mượt
  const TIME_STEPS = [
    1000, 2000, 5000, 10000, 15000, 30000,
    60000, 120000, 300000, 600000, 900000, 1800000,
    3600000, 7200000, 21600000, 43200000, 86400000
  ];

  const st = {
    wrap: null, box: null, canvas: null, ctx: null,
    cssW: 320, cssH: 160, dpr: 1,
    data: [],           // [{t, balance}] — t là mốc thời gian (ms)
    view: null,         // {t0, t1} khung nhìn thời gian hiện tại
    autoFit: true,      // true = luôn vẽ trọn dữ liệu
    dragOn: false, dragX: 0,
    ro: null,           // ResizeObserver
    raf: 0,
    hover: null, tip: null, geom: null
  };

  // ---------- tiện ích ----------
  function p2(n) { return n < 10 ? '0' + n : String(n); }

  
  // Giờ Việt Nam (GMT+7) cố định — không phụ thuộc múi giờ máy/web.
  const TZ_VN = 'Asia/Ho_Chi_Minh';
  function tzParts(ms, withSeconds) {
    const d = new Date(Number(ms));
    try {
      const parts = new Intl.DateTimeFormat('vi-VN', {
        timeZone: TZ_VN, hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(d);
      const get = function (t) { const p = parts.find(function (x) { return x.type === t; }); return p ? p.value : '00'; };
      let s = get('hour') + ':' + get('minute');
      if (withSeconds) s += ':' + get('second');
      return s;
    } catch (e) { /* rơi xuống fallback giờ máy bên dưới */ }
    const p2t = function (n) { return n < 10 ? '0' + n : String(n); };
    let s = p2t(d.getHours()) + ':' + p2t(d.getMinutes());
    if (withSeconds) s += ':' + p2t(d.getSeconds());
    return s;
  }

  function fmtTime(ms, withSeconds) {
    return tzParts(ms, withSeconds === true); // trục: không giây; tooltip: truyền true
  }

  function fmtNum(n) {
    try { return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(Number(n) || 0); }
    catch (e) { return String(Math.round((Number(n) || 0) * 100) / 100); }
  }

  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    const norm = raw / mag;
    const mult = norm <= 1 ? 1 : (norm <= 2 ? 2 : (norm <= 5 ? 5 : 10));
    return mult * mag;
  }

  function pickTimeStep(raw) {
    for (let i = 0; i < TIME_STEPS.length; i++) {
      if (TIME_STEPS[i] >= raw) return TIME_STEPS[i];
    }
    return TIME_STEPS[TIME_STEPS.length - 1];
  }

  function schedule() {
    if (st.raf) return;
    st.raf = requestAnimationFrame(function () { st.raf = 0; render(); });
  }

  // ---------- style ----------
  function ensureStyles() {
    if (document.getElementById('martingale-chart-style')) return;
    const tag = document.createElement('style');
    tag.id = 'martingale-chart-style';
    tag.textContent = [
      '.mg-chart{display:flex;flex-direction:column;width:100%;height:100%;min-height:140px}',
      '.mg-chart-bar{display:flex;gap:6px;justify-content:flex-end;margin:0 0 6px}',
      '.mg-chart-btn{background:#1b2233;color:#e8ecf4;border:1px solid #2f3a52;border-radius:6px;font:12px system-ui,sans-serif;padding:3px 10px;cursor:pointer}',
      '.mg-chart-btn:hover{background:#253049}',
      '.mg-chart-box{position:relative;flex:1;background:#10141d;border:1px solid #2a3245;border-radius:8px;overflow:hidden}',
      '.mg-chart-box canvas{position:absolute;top:0;left:0;width:100%;height:100%;display:block;cursor:grab}',
      '.mg-chart-box canvas.mg-dragging{cursor:grabbing}',
      '.mg-chart-tip{position:absolute;pointer-events:none;background:#0d1117;border:1px solid #3b82f6;border-radius:6px;color:#e8ecf4;font:12px system-ui,sans-serif;padding:4px 8px;display:none;white-space:nowrap;z-index:5;box-shadow:0 2px 8px rgba(0,0,0,.45)}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(tag);
  }

  // ---------- gắn vào DOM ----------
  function mkBtn(text, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mg-chart-btn';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function mount(container) {
    if (!container || typeof container.appendChild !== 'function') return null;
    ensureStyles();
    if (st.wrap && st.wrap.parentNode) st.wrap.parentNode.removeChild(st.wrap);
    if (st.ro) { st.ro.disconnect(); st.ro = null; }

    const wrap = document.createElement('div');
    wrap.className = 'mg-chart';

    const bar = document.createElement('div');
    bar.className = 'mg-chart-bar';
    bar.appendChild(mkBtn('＋', 'Phóng to', function () { zoomAt(0.8, null); }));
    bar.appendChild(mkBtn('－', 'Thu nhỏ', function () { zoomAt(1.25, null); }));
    bar.appendChild(mkBtn('Vừa khung', 'Vừa khung toàn bộ dữ liệu', function () { fitAll(); }));

    const box = document.createElement('div');
    box.className = 'mg-chart-box';
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);

    wrap.appendChild(bar);
    wrap.appendChild(box);
    container.appendChild(wrap);

    st.wrap = wrap; st.box = box; st.canvas = canvas;
    st.ctx = canvas.getContext('2d');

    const tip = document.createElement('div');
    tip.className = 'mg-chart-tip';
    box.appendChild(tip);
    st.tip = tip;
    st.hover = null;
    st.geom = null;
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', function (e) {
      st.dragOn = true;
      st.dragX = e.clientX;
      canvas.classList.add('mg-dragging');
    });
    canvas.addEventListener('dblclick', function () { fitAll(); });
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
    window.addEventListener('resize', onWinResize);

    if (typeof ResizeObserver !== 'undefined') {
      st.ro = new ResizeObserver(function () { resize(); });
      st.ro.observe(box);
    }

    resize();
    return wrap;
  }

  function onWinMove(e) {
    if (!st.dragOn) return;
    panBy(e.clientX - st.dragX);
    st.dragX = e.clientX;
  }

  function onWinUp() {
    st.dragOn = false;
    if (st.canvas) st.canvas.classList.remove('mg-dragging');
  }

  function onWinResize() { resize(); }

  // ---------- hover: tìm điểm gần chuột, hiện tooltip số dư chính xác ----------
  function hideTip() {
    if (st.tip) st.tip.style.display = 'none';
  }
  function showTip(p, g) {
    if (!st.tip) return;
    st.tip.innerHTML = '<b>' + fmtNum(p.balance) + '</b> · ' + fmtTime(p.t, true);
    st.tip.style.display = 'block';
    const tw = st.tip.offsetWidth || 60;
    const th = st.tip.offsetHeight || 24;
    let left = g.xOf(p.t) + 12;
    if (left + tw > st.cssW - 4) left = g.xOf(p.t) - tw - 12;
    if (left < 4) left = 4;
    let top = g.yOf(p.balance) - th - 10;
    if (top < 4) top = g.yOf(p.balance) + 12;
    st.tip.style.left = Math.round(left) + 'px';
    st.tip.style.top = Math.round(top) + 'px';
  }
  function onPointerMove(e) {
    const g = st.geom;
    if (!g || !g.pts.length || !st.canvas) { st.hover = null; hideTip(); return; }
    const rect = st.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null, bestD = 50 * 50;
    for (let i = 0; i < g.pts.length; i++) {
      const dx = g.xOf(g.pts[i].t) - mx, dy = g.yOf(g.pts[i].balance) - my;
      const dd = dx * dx + dy * dy;
      if (dd <= bestD) { bestD = dd; best = g.pts[i]; }
    }
    if (!best) { if (st.hover) { st.hover = null; schedule(); } hideTip(); return; }
    st.hover = { t: best.t, balance: best.balance };
    showTip(best, g);
    schedule();
  }
  function onPointerLeave() {
    if (st.hover) { st.hover = null; schedule(); }
    hideTip();
  }

  function onWheel(e) {
    e.preventDefault();
    let t = null;
    if (st.canvas) {
      const rect = st.canvas.getBoundingClientRect();
      t = timeAtX(e.clientX - rect.left);
    }
    zoomAt(e.deltaY > 0 ? 1.25 : 0.8, t);
  }

  // ---------- kích thước ----------
  function resize() {
    if (!st.canvas || !st.box) return;
    const w = st.box.clientWidth;
    const hgt = st.box.clientHeight;
    if (w < 40 || hgt < 40) return; // panel đang thu nhỏ — bỏ qua
    st.cssW = w;
    st.cssH = hgt;
    st.dpr = window.devicePixelRatio || 1;
    st.canvas.width = Math.round(w * st.dpr);
    st.canvas.height = Math.round(hgt * st.dpr);
    schedule();
  }

  // ---------- dữ liệu & khung nhìn ----------
  function setData(chart) {
    const arr = Array.isArray(chart) ? chart : [];
    const pts = [];
    for (let i = 0; i < arr.length && pts.length < MAX_POINTS; i++) {
      const p = arr[i];
      if (p && typeof p.t === 'number' && isFinite(p.t) &&
          typeof p.balance === 'number' && isFinite(p.balance)) {
        pts.push({ t: p.t, balance: p.balance });
      }
    }
    // nếu chỉ là nối thêm điểm mới thì giữ nguyên khung nhìn người dùng đang xem
    const prev = st.data;
    const appendOnly = prev.length > 0 && pts.length >= prev.length &&
      pts.length > 0 && pts[0].t === prev[0].t;
    st.data = pts;
    if (appendOnly) followLatest();
    else { st.autoFit = true; st.view = null; }
    schedule();
  }

  function push(point) {
    if (!point || typeof point.t !== 'number' || typeof point.balance !== 'number') return;
    st.data.push({ t: point.t, balance: point.balance });
    if (st.data.length > MAX_POINTS) st.data.splice(0, st.data.length - MAX_POINTS);
    followLatest();
    schedule();
  }

  // nếu khung nhìn đang bám mép phải thì trượt theo điểm mới nhất
  function followLatest() {
    const d = st.data;
    if (!d.length || st.autoFit) return;
    if (!st.view) { st.autoFit = true; return; }
    const lastT = d[d.length - 1].t;
    const span = st.view.t1 - st.view.t0;
    if (lastT > st.view.t1 - span * 0.02) {
      st.view.t1 = lastT;
      st.view.t0 = lastT - span;
      clampView();
    }
  }

  function fitAll() {
    st.autoFit = true;
    st.view = null;
    schedule();
  }

  function clampView() {
    const d = st.data;
    if (!d.length || !st.view) return;
    const dMin = d[0].t;
    const dMax = d[d.length - 1].t;
    const span = st.view.t1 - st.view.t0;
    const lo = dMin - span * 0.5;
    const hi = dMax + span * 0.5;
    if (st.view.t0 < lo) { st.view.t0 = lo; st.view.t1 = lo + span; }
    if (st.view.t1 > hi) { st.view.t1 = hi; st.view.t0 = hi - span; }
  }

  function zoomAt(factor, centerT) {
    const d = st.data;
    if (!d.length) return;
    if (st.autoFit || !st.view) st.view = { t0: d[0].t, t1: d[d.length - 1].t };
    st.autoFit = false;
    const v = st.view;
    const span = Math.max(1, v.t1 - v.t0);
    const full = Math.max(1, d[d.length - 1].t - d[0].t);
    const c = (centerT == null) ? (v.t0 + v.t1) / 2 : centerT;
    const ns = Math.min(
      Math.max(span * factor, MIN_SPAN_MS),
      Math.max(MIN_SPAN_MS, full * 3 + MIN_SPAN_MS)
    );
    const k = ns / span;
    const t0 = c - (c - v.t0) * k;
    st.view = { t0: t0, t1: t0 + ns };
    clampView();
    schedule();
  }

  function panBy(dx) {
    if (!st.view || !st.data.length) return;
    const span = st.view.t1 - st.view.t0;
    const plotW = Math.max(1, st.cssW - PAD.left - PAD.right);
    const dt = (dx / plotW) * span;
    st.autoFit = false;
    st.view.t0 -= dt;
    st.view.t1 -= dt;
    clampView();
    schedule();
  }

  function timeAtX(x) {
    const d = st.data;
    if (!d.length) return null;
    if (!st.view) st.view = { t0: d[0].t, t1: d[d.length - 1].t };
    const plotW = Math.max(1, st.cssW - PAD.left - PAD.right);
    const frac = (x - PAD.left) / plotW;
    return st.view.t0 + frac * (st.view.t1 - st.view.t0);
  }

  // ---------- vẽ ----------
  function drawPlaceholder(ctx, msg) {
    ctx.fillStyle = COLOR.text;
    ctx.font = 'italic 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'Chưa có dữ liệu số dư', st.cssW / 2, st.cssH / 2);
  }

  function render() {
    const ctx = st.ctx;
    if (!ctx || !st.canvas) return;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, st.cssW, st.cssH);
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, st.cssW, st.cssH);

    const plotW = st.cssW - PAD.left - PAD.right;
    const plotH = st.cssH - PAD.top - PAD.bottom;
    if (!st.data.length || plotW < 20 || plotH < 20) {
      st.geom = null;
      drawPlaceholder(ctx, 'Chưa có dữ liệu số dư');
      return;
    }

    const d = st.data;
    if (st.autoFit || !st.view) st.view = { t0: d[0].t, t1: d[d.length - 1].t };
    const v = st.view;
    const span = Math.max(1, v.t1 - v.t0);

    // các điểm nằm trong khung nhìn
    const pts = [];
    for (let i = 0; i < d.length; i++) {
      if (d[i].t >= v.t0 && d[i].t <= v.t1) pts.push(d[i]);
    }
    if (!pts.length) {
      st.geom = null;
      drawPlaceholder(ctx, 'Ngoài vùng dữ liệu — nhấp đôi chuột để vừa khung');
      return;
    }

    // trục Y theo đúng dữ liệu đang thấy
    let bMin = Infinity, bMax = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].balance < bMin) bMin = pts[i].balance;
      if (pts[i].balance > bMax) bMax = pts[i].balance;
    }
    if (bMin === bMax) { bMin -= 1; bMax += 1; }
    const bPad = (bMax - bMin) * 0.1;
    bMin -= bPad;
    bMax += bPad;

    function xOf(t) { return PAD.left + ((t - v.t0) / span) * plotW; }
    function yOf(b) { return PAD.top + (1 - (b - bMin) / (bMax - bMin)) * plotH; }
    st.geom = { pts: pts, xOf: xOf, yOf: yOf };

    // lưới ngang + nhãn số dư (bên phải)
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    const ys = niceStep(bMax - bMin, 4);
    for (let y = Math.ceil(bMin / ys) * ys; y <= bMax; y += ys) {
      const py = Math.round(yOf(y)) + 0.5;
      ctx.strokeStyle = COLOR.grid;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + plotW, py);
      ctx.stroke();
      ctx.fillStyle = COLOR.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtNum(y), PAD.left + plotW + 6, py);
    }

    // lưới dọc + nhãn thời gian (giờ:phút, có giây khi bước < 1 phút)
    const ts = pickTimeStep(span / 6);
    for (let t = Math.ceil(v.t0 / ts) * ts; t <= v.t1; t += ts) {
      const px = Math.round(xOf(t)) + 0.5;
      if (px < PAD.left - 1 || px > PAD.left + plotW + 1) continue;
      ctx.strokeStyle = COLOR.grid;
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, PAD.top + plotH);
      ctx.stroke();
      ctx.fillStyle = COLOR.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(fmtTime(t, ts < 60000), px, PAD.top + plotH + 6);
    }

    // đường số dư
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = xOf(pts[i].t);
      const y = yOf(pts[i].balance);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // tô nhẹ phía dưới đường (chỉ khi có > 1 điểm)
    if (pts.length > 1) {
      ctx.lineTo(xOf(pts[pts.length - 1].t), PAD.top + plotH);
      ctx.lineTo(xOf(pts[0].t), PAD.top + plotH);
      ctx.closePath();
      ctx.fillStyle = COLOR.fill;
      ctx.fill();
    }

    // đánh dấu điểm mới nhất
    const lp = pts[pts.length - 1];
    const lx = xOf(lp.t);
    const ly = yOf(lp.balance);
    ctx.beginPath();
    ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.dot;
    ctx.fill();
    ctx.strokeStyle = COLOR.bg;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // điểm đang hover: vạch dẫn 2 trục + vòng sáng
    if (st.hover) {
      const hx = xOf(st.hover.t), hy = yOf(st.hover.balance);
      ctx.strokeStyle = 'rgba(255,209,102,0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(hx, PAD.top); ctx.lineTo(hx, PAD.top + plotH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD.left, hy); ctx.lineTo(PAD.left + plotW, hy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.strokeStyle = COLOR.dot; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  root.MartingaleChart = {
    mount: mount,
    setData: setData,
    push: push,
    fit: fitAll,
    reset: function () { setData([]); }
  };
})();
