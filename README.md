# Martingale Extension

Extension Chrome (Manifest V3) cung cấp **bảng điều khiển nổi** để vận hành chuỗi Martingale trên một ứng dụng web trực tuyến bất kỳ: theo dõi số dư real-time, tự động hóa từng lượt theo quy tắc nhân đôi/khôi phục, thống kê phiên và biểu đồ có thể thu-phóng.

> Mục đích giáo dục / nghiên cứu — minh họa kiến trúc extension điều khiển trạng thái, bám DOM SPA và trực quan hóa dữ liệu thời gian thực.

## Tech stack

| Thành phần | Công nghệ |
|---|---|
| Nền tảng | Chrome Extension Manifest V3 (content scripts + service worker) |
| Ngôn ngữ | Vanilla JavaScript (ES2020), **không build step, không dependency** |
| DOM tracker | Polling + MutationObserver, chống mất bám SPA |
| RNG | `crypto.getRandomValues` — nguồn entropy mã hóa, không dùng `Math.random` |
| Lưu trữ | `chrome.storage` shim sang `localStorage` cho môi trường test |
| Biểu đồ | Canvas 2D tự viết, zoom (con lăn) + pan (kéo) |
| Phím tắt | `chrome.commands` + service worker chuyển tiếp |
| Dev | Trang mock (`dev/mock.html`) mô phỏng game + bridge xác minh — chạy bằng `python3 -m http.server` |

## Tính năng

- Bảng điều khiển nổi: nhập mức khởi điểm, Bắt đầu / Tạm dừng / Tiếp tục / Đặt lại
- Chuỗi Martingale: thắng → về mức gốc, thua → ×2; dừng tự động khi số dư ≤ 30% mốc gốc hoặc không đủ tiền cho lượt kế tiếp
- Chống lỗi: tiền thập phân 2 chữ số, kiểm đủ tiền trước mỗi lượt, chống đọc trùng kết quả bằng dấu vân tay, sống sót qua reload (khôi phục phiên + đối soát lượt dang dở)
- Thống kê: vòng / thắng / thua / chuỗi thua, xuất CSV, biểu đồ số dư theo thời gian
- Phím tắt thu/phóng dashboard (đổi được trong `chrome://extensions/shortcuts`)

## Cấu trúc

\`\`\`
manifest.json          khai báo MV3, content scripts, commands
background.js          service worker: chuyển phím tắt vào tab
content/
  rng.js               nguồn ngẫu nhiên mã hóa
  storage.js           lưu/khôi phục phiên
  dom.js               bộ bám DOM + bộ đọc/ghi giao diện trang
  cf-watch.js          phát hiện trang bị chặn/khả dụng lại
  stats.js             toán học Martingale (thuần, dễ test)
  engine.js            máy trạng thái phiên
  chart.js             biểu đồ canvas
  ui.js                dashboard nổi
  main.js              khởi động, nối dây các module
dev/
  mock.html/.css       trang mô phỏng để thử extension không cần web thật
  mock-bridge.js       cầu nối mock ↔ dashboard
\`\`\`

## Chạy thử

1. Sửa `manifest.json`: thay `https://example.com/*` bằng domain của ứng dụng bạn muốn gắn.
2. `chrome://extensions` → bật Developer mode → **Load unpacked** → chọn thư mục này.
3. Mở ứng dụng, bấm 🎲 trên dashboard, nhập mức khởi điểm → Bắt đầu.
4. Hoặc chạy trang mock: \`python3 -m http.server 8088\` trong thư mục repo → mở \`http://localhost:8088/dev/mock.html\`.

## Phím tắt mặc định

- macOS: \`Cmd+Shift+X\` — Windows/Linux: \`Alt+Shift+X\` (đổi được trong `chrome://extensions/shortcuts`)

## Giấy phép

MIT
