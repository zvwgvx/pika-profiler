# pika-profiler

Minecraft in-game player intelligence & stats bot cho **Pika-Network** – tự động nhận diện rank, chuẩn hóa username hoa/thường, check BedWars stats qua guild chat với SOCKS5 proxy support.

## Cài đặt

```bash
# 1. Clone / vào thư mục project
cd pika-profiler

# 2. Cài dependencies
npm install

# 3. Tạo file .env từ mẫu
cp .env.example .env
# Sau đó mở .env và điền thông tin tài khoản Minecraft của bot
```

## Cấu hình `.env`

| Biến | Mô tả | Mặc định |
|------|-------|---------|
| `MC_USERNAME` | Username tài khoản bot | *(bắt buộc)* |
| `SERVER_PASSWORD` | Mật khẩu tài khoản (dùng cho server /login) | *(bắt buộc)* |
| `MC_AUTH` | `offline` hoặc `microsoft` | `offline` |
| `MC_HOST` | Host server | `play.pika-network.net` |
| `MC_PORT` | Port | `25565` |
| `MC_VERSION` | Phiên bản game | `1.20.1` |
| `SOCKS5_PROXY` | Proxy SOCKS5 (`ip:port:user:pass` hoặc `ip:port`) | *(tùy chọn)* |
| `CMD_PREFIX` | Prefix lệnh | `.` |
| `DEFAULT_INTERVAL` | `total` \| `monthly` \| `weekly` | `total` |
| `DEFAULT_MODE` | `ALL_MODES` \| `SOLO` \| `DOUBLES` \| `TRIPLES` \| `QUADS` | `ALL_MODES` |

## Chạy bot

```bash
npm start

# hoặc chế độ dev (tự restart khi sửa code)
npm run dev
```

## Cách dùng trong Guild Chat

```
.stat {username} [interval] [mode]
```

| Tham số | Giá trị hợp lệ | Ví dụ |
|---------|---------------|-------|
| `username` | IGN của người chơi | `Notch` |
| `interval` | `total` / `monthly` / `weekly` | `monthly` |
| `mode` | `all` / `solo` / `doubles` / `triples` / `quads` | `solo` |

### Ví dụ

```
.stat Notch                    → stats all modes, total
.stat Notch monthly            → stats all modes, tháng này
.stat Notch total solo         → stats solo, toàn thời gian
```

### Output mẫu

```
[BW All/Total] Notch | W: 120 L: 45 WLR: 2.67 | K: 890 D: 310 KDR: 2.87 | FK: 200 FD: 60 FKDR: 3.33 | Beds: 180
```

## Cooldown

Mỗi người dùng phải chờ **5 giây** giữa các lần dùng `.stat` để tránh spam API.
