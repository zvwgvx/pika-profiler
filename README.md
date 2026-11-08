# pika-profiler

BedWars stats bot for PikaNetwork. Answers `.stat` commands from guild chat.

## Features

- `.stat <player> [mode] [interval]` from guild chat
- Stats: W, WLR, K, KDR, FK, FKDR
- Player names colored by rank (Champion, Titan, Elite, VIP)
- Case-insensitive username resolution
- SOCKS5 proxy support (`ip:port:user:pass`)
- Auto `/login` and lobby navigation
- Per-player cooldown

## Setup

```bash
npm install
cp .env.example .env  # edit it
npm start
```

Dev mode: `npm run dev`. `run.sh` for production.

## Config

| Variable | Meaning | Default |
|:--|:--|:--|
| `MC_USERNAME` | Bot username | required |
| `SERVER_PASSWORD` | `/login` password | required |
| `PIKA_API_KEY` | API key (run `/apikey` in-game) | required |
| `MC_AUTH` | `offline` or `microsoft` | `offline` |
| `MC_HOST` | Server host | `play.pika-network.net` |
| `MC_PORT` | Server port | `25565` |
| `MC_VERSION` | Client version | `1.20.1` |
| `SOCKS5_PROXY` | `ip:port:user:pass` or `ip:port` | - |
| `CMD_PREFIX` | Command prefix | `.` |
| `DEFAULT_INTERVAL` | `total`, `monthly`, `weekly` | `total` |
| `DEFAULT_MODE` | `ALL_MODES`, `SOLO`, `DOUBLES`, `QUAD` | `ALL_MODES` |

API key request: sent as `X-Api-Key` header, quota 120/window, `401` on invalid key.

## Usage

Send this from guild chat (`/g c`):

```text
.stat <username> [mode] [interval]
```

- `mode`: `1` Solo, `2` Doubles, `4` Quads (default: all)
- `interval`: `week`, `month`, `year` (default: lifetime)

```text
.stat Notch
.stat Notch 2 month
.stat Notch 4 week
```

Output:

```text
Notch | Doubles Weekly | W: 15 WLR: 7.50 | K: 66 KDR: 4.71 | FK: 64 FKDR: 32.00
```

## Roadmap

- [x] BedWars stats checker
- [x] API key auth
- [x] Rank colors
- [x] Case-insensitive lookup
- [x] SOCKS5 proxy
- [ ] Denicker
- [ ] Alt detector

## License

MIT.
