// background.js — MV3 service worker: chuyển phím tắt thành lệnh toggle dashboard
chrome.commands.onCommand.addListener(function (command) {
  if (command !== 'toggle-dashboard' && command !== '_execute_action') return;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs[0] || !tabs[0].id) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'martingale_TOGGLE_PANEL' }, function () {
      void chrome.runtime.lastError; // tab không có content script — bỏ qua im lặng
    });
  });
});

// Nhịp đập chống giảm nhịp tab ẩn (Intensive Timer Throttling):
// khi người dùng rời tab (sang cửa sổ/user khác), Chrome chỉ còn cho timer của
// trang chạy ~1 lần/phút sau 5 phút. Service worker được đánh thức theo alarm
// nên mỗi 30s gửi 1 "cú hích" xuống content script — content script gọi thẳng
// engine.tick() để giữ nhịp đặt lệnh/khám phá kết quả đều như khi tab hiển thị.
try {
  chrome.alarms.create('tick-pulse', { periodInMinutes: 0.5 });
} catch (e0) { /* bỏ qua */ }
try {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm || alarm.name !== 'tick-pulse') return;
    chrome.tabs.query({ url: chrome.runtime.getManifest().content_scripts[0].matches }, function (tabs) {
      if (!tabs || !tabs.length) return;
      for (let i = 0; i < tabs.length; i++) {
        chrome.tabs.sendMessage(tabs[i].id, { type: 'MARTINGALE_TICK' }, function () {
          void chrome.runtime.lastError; // tab không có content script — bỏ qua
        });
      }
    });
  });
} catch (e1) { /* bỏ qua */ }
