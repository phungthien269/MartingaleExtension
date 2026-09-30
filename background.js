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
