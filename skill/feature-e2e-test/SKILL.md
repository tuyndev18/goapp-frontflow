---
name: feature-e2e-test
description: Khung test E2E một tính năng bất kỳ trên server dev bằng Playwright + tài khoản pool (tools/guide-gen) — chọn pha theo đặc điểm tính năng, lập ROAD-MAP công bố trước khi chạy, báo tiến độ từng bước, phủ case lạ theo nhóm chung, chạy tiếp được khi đứt giữa chừng, báo cáo theo mẫu. Dùng khi được yêu cầu "test full luồng", "test chuyên sâu", "thêm case dị", "chạy E2E", "kiểm thử tính năng X cho role A/B", hoặc sau khi làm xong một tính năng có nhiều vai cần kiểm trên server thật.
---

# feature-e2e-test

Skill này là **khung** để test end-to-end một tính năng trên môi trường dev thật: thao tác qua giao diện bằng Playwright, nhiều vai cùng lúc, dữ liệu thật. Nó không gắn với tính năng nào — đọc mục 3 để dựng road-map riêng cho tính năng đang test. Không dạy viết unit test (xem `Code Conventions` trong CLAUDE.md).

Trả lời 5 câu: **Chuẩn bị gì · Road-map dựng thế nào · Case lạ lấy ở đâu · Báo tiến độ ra sao · Báo cáo gì**.

Khung script để copy: [templates/probe-template.mjs](templates/probe-template.mjs)

---

## 1. Nguyên tắc (không thương lượng)

1. **Thao tác = UI.** Mọi hành động người dùng (tạo, bấm, nhập, duyệt) đi qua giao diện, đúng như người thật làm.
2. **Kiểm chứng: API được dùng ở lượt đầu, mục tiêu là thuần UI.** Lượt đầu được đọc API (chỉ quyền XEM) để xác nhận nhanh, báo rõ bước nào kiểm bằng API. Khi luồng ổn định thì chuyển kiểm chứng sang chữ trên màn của chính vai đó.
3. **Tài khoản THẬT từ pool** (`leasePoolUnames` → `ssoLogin`), không login demo. Luôn `releasePoolAccounts()` trong `finally`.
4. **Vai điều hành mở cửa sổ có giao diện** (`openSession(acc, tag, { visible: true })`) để người chạy test xem trực tiếp; các vai còn lại chạy headless.
5. **Một bước lỗi không dừng cả lượt**: `step()` bắt lỗi, ghi ✘, đi tiếp. Chỉ dừng khi thiếu tiền đề (không tạo được đối tượng chính).
6. **Không đụng dữ liệu ngoài phạm vi test**: mỗi lượt tạo đối tượng mới. Lượt kiểm giao diện thì chỉ xem.
7. **Không `goto` / reload trang giữa các bước của cùng một vai.** Đang ở đúng trang thì điều hướng trong app (tab, nút). Tải lại làm mất state đang test và người xem tưởng app tự F5. Chỉ `goto` khi phải sang trang khác.

## 2. Chuẩn bị

| Việc | Khi nào | Lệnh / ghi chú |
|---|---|---|
| Dev server | luôn | `yarn dev --port 7456 --strictPort` — port khác bị chặn; port bận thì dừng tiến trình cũ, không để Vite nhảy port |
| Pool tài khoản | luôn | đếm trước theo vai: `readAccounts()` lọc `role`, `status === 'profile_done'` (+ thuộc tính tính năng cần, ví dụ khối) |
| Script | luôn | copy khung → `tools/guide-gen/_probe-<tinh-nang>.mjs` (gitignore theo mẫu `_probe-*.mjs`) |
| Hook tự chơi trận | tính năng có trận đấu | `.env` có `VITE_GUIDE_HOOKS=1` (cho `autoPlayUntilEnd` của `lib/match-flow.mjs`) |
| Đáp án CMS | tính năng có trận đấu | `tools/guide-gen/.env` có `CMS_*` |

## 3. Dựng road-map

### 3.1 Chọn pha

Trả lời các câu dưới cho tính năng đang test; câu nào "có" thì thêm pha tương ứng. Thứ tự giữ như bảng.

| # | Pha | Thêm khi tính năng… | Kiểm tối thiểu |
|---|---|---|---|
| 1 | **Khởi tạo** | có form tạo / gửi | mỗi luật validate hiện đúng câu lỗi → tạo hợp lệ → đối tượng xuất hiện đúng chỗ |
| 2 | **Cấu hình** | có màn / modal cấu hình sau khi tạo | lưu → đọc lại thấy đúng → đổi qua lại A → B → A |
| 3 | **Truy cập / tham gia** | có nhiều cách để người dùng khác vào (link, mã, tìm, được thêm) | mỗi đường vào + đầu vào sai khuôn / không tồn tại / hết hạn |
| 4 | **Kiểm duyệt** | có bước chờ người khác duyệt | chờ → duyệt; chờ → từ chối có lý do → xin lại → duyệt |
| 5 | **Quan hệ giữa vai** | một vai mời / gán / chia sẻ cho vai khác | gửi → bên kia từ chối → gửi lại → đồng ý; gửi → thu hồi → bên kia hết thấy |
| 6 | **Giới hạn & khoá** | có trần (số lượng, thời gian, quyền) hoặc khoá theo trạng thái | chạm trần bị chặn; gỡ để mở chỗ; nút khoá / ẩn đúng lúc |
| 7 | **Luồng chính** | luôn | chạy hết vòng đời với số người đủ lớn để lộ ca biên (số lẻ, nhiều trang) |
| 8 | **Bất thường giữa chừng** | luồng kéo dài hoặc nhiều người | bỏ giữa chừng, offline / reconnect, đổi quyết định, tạm dừng / tiếp tục, thao tác lại sau khi đã xong |
| 9 | **Kết thúc & kết quả** | có trạng thái cuối / kết quả | chốt kết quả, mỗi vai xem đúng phần của mình, chụp màn kết quả |

### 3.2 Công bố trước khi chạy

Gửi bảng road-map cho người yêu cầu **trước khi chạy**: mỗi pha 1 dòng, liệt kê case chính, đánh dấu ★ case lạ mới. Mỗi pha ứng với một `setPhase()` trong script, mỗi case một `step()`.

Road-map phải đọc được như **timeline**, không chỉ danh sách pha:

| # | Pha / mốc | Case chính | Ước tính | Bắt đầu → xong (giờ đồng hồ) |
|---|---|---|---|---|
| 1 | Khởi tạo | … | ~1′ | 10:32 → 10:33 |
| — | ⏳ Chờ mốc hệ thống (vd giờ bắt đầu) | không thao tác | 45′ | 10:44 → 11:27 |

- **Ước tính** mỗi pha lấy từ lần chạy trước (log có giờ mỗi `setPhase`); chưa có thì ước theo số bước × thời gian một thao tác, ghi rõ "ước".
- **Mốc cứng** do luật nghiệp vụ / server (chờ tới giờ, cooldown, hết hạn) tách thành dòng ⏳ riêng — thường chiếm phần lớn tổng thời gian, người đọc cần thấy ngay.
- Ghi **tổng thời gian** và **giờ dự kiến xong**. Khi báo tiến độ, so thực tế với ước tính: pha nào trễ > 50% thì nói lý do.

## 4. Case lạ theo nhóm chung

Với mỗi pha đã chọn, đi qua các nhóm dưới và thêm case nào áp dụng được.

| Nhóm | Câu hỏi để sinh case |
|---|---|
| Validate & biên | giá trị dưới / trên trần, trống, sai thứ tự, sai định dạng? |
| Đổi qua lại | đổi rồi đổi về; xoá hết rồi tạo lại; làm lại một thao tác đã làm? |
| Mã / link / token | sai khuôn (client chặn), không tồn tại (server), cũ sau khi đổi, bị thay bởi bản mới? |
| Quyết định lặp | từ chối rồi được gửi lại; rút rồi vào lại; huỷ rồi làm lại? |
| Trần & sức chứa | đầy thì người kế bị chặn với câu báo đúng; gỡ một người thì vào được? |
| Khoá theo trạng thái | nút bị khoá khi đã có dữ liệu phụ thuộc; ẩn khi đối tượng đã kết thúc? |
| Mất kết nối | đóng trang đúng lúc server xử lý; reconnect có tự đồng bộ lại? |
| Bỏ giữa chừng | người rời đi giữa luồng → hậu quả cho chính họ VÀ cho người liên quan có đúng? |
| Số lẻ / rỗng | số người lẻ, danh sách rỗng, đúng 1 phần tử, tràn sang trang 2? |
| Thời gian | đơn vị epoch giây vs mili giây; job / scheduler server trễ; đồng hồ client lệch? |
| Push mất gói | trạng thái chỉ đến qua push → tải lại trang vẫn phải đúng (đọc nguồn bền)? |
| Chữ hiển thị | thông báo server tiếng Anh thô, mã lỗi trần lọt lên UI? |

## 5. Báo tiến độ từng bước

1. Trước khi chạy: gửi bảng road-map (mục 3.2).
2. Chạy nền rồi bật `Monitor` theo đúng 2 mẫu log của khung script:
   ```
   tail -n +1 -f <log> | grep -E --line-buffered "══════ PHA|   ✔|   ✘|DỪNG|Error|KẾT QUẢ"
   ```
   Monitor tự hết hạn sau 30 phút — đặt lại nếu lượt chạy dài hơn.
3. Mỗi sự kiện báo 1 dòng ngắn: ✔/✘ + ý nghĩa nghiệp vụ, không dán log thô. Gặp ✘ thì xem log ngay, kết luận lỗi app hay lỗi script.
4. Lỗi script làm hỏng các bước sau → **dừng ngay** (TaskStop **và** kill tiến trình node con — trên Windows TaskStop chỉ dừng lớp bash bọc ngoài), sửa script, rồi chạy tiếp (mục 6).

## 6. Chạy tiếp (resume)

Script phải chạy tiếp được trên đối tượng đã tạo: `--resume=<id> --accounts=<u1,u2,… đúng thứ tự cũ>`.
- Bọc các pha đã xong trong `if (!RESUME) { ... }`; khai báo vai / helper dùng chung ra ngoài khối.
- Truyền lại đúng thứ tự tài khoản để S1…Sn trỏ đúng người.
- Trước khi chạy: đọc trạng thái hiện tại (API) để chọn điểm bắt đầu; kiểm `rt.pool_lease` — còn pid sống thì kill pid đó (lease chỉ tự nhả khi tiến trình chết).

## 7. Mẹo selector & bẫy

**Chung cho app:**

| Bẫy | Cách làm đúng |
|---|---|
| Nút mở modal xác nhận và nút xác nhận cùng nhãn | `btn(page, 'X').last().click()` (`clickLast`) |
| Đọc toast (`core/Toast`) | khối `[class*="z-[10050]"]`, đọc trong ~1s sau thao tác |
| Nút "Đóng" của toast | toast có nút aria-label "Đóng" — đóng modal thì tìm nút **trong** khung modal |
| Nhãn ô nhập kèm gợi ý | `getByLabel(/^Nhãn/)` (regex neo đầu) |
| DatePicker antd | click input → `fill('DD/MM/YYYY HH:mm')` → `Enter` |
| Khung modal của module | mỗi module có khung riêng — tra class khung trong `components/modals` của module rồi đặt `modal(page)` theo đó |

**Môi trường (Windows + Git Bash):**

| Bẫy | Cách làm đúng |
|---|---|
| Template literal trong `node -e` | bị bash nuốt — sửa file bằng Edit/Write |
| File CRLF | thay chuỗi theo `\n` sẽ trượt — dùng Edit tool |
| Tiến trình node còn sống sau TaskStop | `Get-CimInstance Win32_Process` lọc theo tên script rồi `Stop-Process` |

## 8. Mẫu báo cáo cuối

```
Kết luận 1 câu: chạy trọn được chưa, bao nhiêu bước đạt, lỗi nghiêm trọng nhất.

Bảng theo pha: | Pha | Kết quả | Ghi chú (case lạ ★) |
Lỗi tìm thấy:
  - Lỗi FE (đã sửa / chưa sửa) — bằng chứng
  - Nghi lỗi server — id đối tượng, uid, dữ liệu thô để BE tra
Đã sửa trong lượt (nếu có).
Tài khoản đã dùng: bảng vai | tài khoản | uid | dùng để test gì.
Chưa kiểm được + lý do. Bước tiếp theo đề xuất.
```

Có bằng chứng mới mâu thuẫn kết luận cũ thì sửa lại và nói rõ đã nhầm ở đâu.
