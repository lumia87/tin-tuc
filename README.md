# Tăng tốc bằng data.json dựng sẵn

Thay vì để trình duyệt đi lấy 18–39 feed qua cầu nối CORS công cộng, ta cho **GitHub
chạy việc đó 30 phút một lần** rồi ghi kết quả ra `data.json` ngay trong kho. Trình
duyệt chỉ tải một file — giống cách Feedly hay Inoreader làm.

Đo được trên bản thử: thấy bài sau **160ms**, gọi cầu nối CORS **0 lần**.

## Cây thư mục trong kho

```
kho-cua-ban/
├─ index.html                        ← trang (đổi tên từ tin-tuc.html / tin-nhan-su.html)
├─ fetch-feeds.mjs                   ← script gom feed
├─ data.json                         ← GitHub tự sinh: danh sách bài (nhẹ)
├─ content/                          ← GitHub tự sinh: toàn văn tách theo từng nguồn
│  ├─ netflix.json
│  └─ …
└─ .github/
   └─ workflows/
      └─ update-feeds.yml            ← lịch chạy
```

`data.json` chỉ chứa tiêu đề và tóm tắt nên tải rất nhanh. Toàn văn nằm trong
`content/<id nguồn>.json`, trang chỉ tải file của nguồn nào khi bạn mở bài của nguồn
đó — mở bài mất khoảng 60ms thay vì gần một giây. Feed nào không kèm toàn văn thì
trang vẫn tải trang gốc qua cầu nối như trước.

## Các bước

```bash
# trong thư mục kho đã có index.html
mkdir -p .github/workflows
cp update-feeds.yml .github/workflows/update-feeds.yml
# đặt fetch-feeds.mjs vào thư mục gốc

git add index.html fetch-feeds.mjs .github/workflows/update-feeds.yml
git commit -m "Gom RSS sẵn bằng GitHub Actions"
git push
```

Vào tab **Actions** của kho, chọn **Gom tin RSS** → **Run workflow** để chạy ngay lần
đầu (không phải chờ tới mốc 30 phút). Chạy xong sẽ thấy `data.json` xuất hiện trong kho.

Nếu Actions báo lỗi không đẩy được `data.json`, vào **Settings → Actions → General →
Workflow permissions** và chọn **Read and write permissions**.

## Cách trang hoạt động sau đó

1. Mở trang → hiện ngay bài đã lưu lần trước trong trình duyệt.
2. Gọi `data.json` → thay bằng dữ liệu mới, **không đụng tới cầu nối CORS**.
3. Không có `data.json` (ví dụ mở file rời bằng `file://`) → tự quay về cách cũ là lấy
   trực tiếp từng feed. File vẫn dùng được độc lập như trước.
4. Nguồn bạn tự thêm bằng nút "+ Nguồn" không nằm trong `data.json` nên vẫn được lấy
   trực tiếp.

Dòng trạng thái hiện "dựng sẵn X phút trước" để bạn biết dữ liệu mới tới đâu.

## Thêm hoặc bớt nguồn

Chỉ sửa mảng `SOURCES` trong `index.html` rồi push. Workflow đọc danh sách nguồn
**từ chính file đó**, nên không phải khai báo hai nơi; đẩy lên là nó tự dựng lại.

## Chỉnh nhịp chạy

Trong `update-feeds.yml`, sửa dòng `cron`:

| Nhịp | cron |
|---|---|
| 15 phút/lần | `*/15 * * * *` |
| 30 phút/lần (mặc định) | `*/30 * * * *` |
| 1 giờ/lần | `0 * * * *` |
| 8 giờ sáng VN mỗi ngày | `0 1 * * *` |

Giờ trong cron là UTC, Việt Nam là UTC+7. GitHub có thể chạy trễ vài phút khi hệ
thống bận — đây là hành vi bình thường của cron miễn phí, không phải lỗi.

## Bóc nội dung trang gốc lúc dựng

Feed nào không kèm toàn văn (điển hình là các luồng Google News), script sẽ tự tải
trang gốc rồi bóc phần thân bài bằng Readability — thư viện đứng sau chế độ Reader
của Firefox. Chạy trên máy GitHub nên không vướng CORS.

Kết quả lần trước được dùng lại, nên mỗi lần chạy chỉ tải những bài thật sự mới
(thường vài chục bài thay vì cả trăm). Muốn tắt hẳn bước này thì đặt biến môi trường
`EXTRACT=0`, hoặc giảm `EXTRACT_MAX` (mặc định 250 bài mới mỗi lần).

## Hai kiểu workflow — chọn một

| | `update-feeds.yml` | `update-feeds-pages.yml` |
|---|---|---|
| Cách xuất bản | commit `data.json` + `content/` vào kho | đưa thẳng lên Pages, không commit |
| Cài đặt Pages | Deploy from a branch | **GitHub Actions** |
| Kho phình to | có, mỗi lần chạy thêm vài MB vào lịch sử git | không |
| Nhịp chạy nên dùng | 2 giờ/lần trở lên | 30 phút/lần thoải mái |
| Xem được file trong kho | có | không |

Nếu bật bóc nội dung thì nên dùng bản Pages: toàn văn khoảng 10–15 KB một bài, 900 bài
là hơn 10 MB — commit chừng đó mỗi 30 phút sẽ làm kho nặng lên rất nhanh và không xoá
lại được vì nằm trong lịch sử git.

Đổi sang bản Pages: chép `update-feeds-pages.yml` thành
`.github/workflows/update-feeds.yml` (đè bản cũ), rồi vào **Settings → Pages**, đổi
Source thành **GitHub Actions**.

## Vài giới hạn cần biết

- Bài mới nhất có thể trễ tối đa bằng nhịp chạy (mặc định 30 phút). Cần tươi hơn thì
  giảm cron, hoặc bấm **Làm mới** — nhưng nút đó cũng chỉ tải lại `data.json`.
- `data.json` giữ tối đa 900 bài, mỗi nguồn 25 bài mới nhất. Sửa `MAX_ITEMS` và
  `MAX_PER_SOURCE` trong `fetch-feeds.mjs` nếu muốn khác.
- Khung đọc bài trong trang vẫn cần cầu nối CORS để lấy nội dung bài viết, vì
  `data.json` chỉ chứa tiêu đề và tóm tắt cho nhẹ.
- Mỗi lần chạy tốn khoảng 1 phút máy của GitHub. Kho công khai được miễn phí không
  giới hạn, nên nhịp 30 phút không phát sinh chi phí.
