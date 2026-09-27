# pika-profiler

An in-game Minecraft player intelligence & BedWars stats bot for **PikaNetwork** built with Node.js and Mineflayer. Automatically detects ranks, resolves player username casing, checks statistics directly via guild chat, and routes connections through SOCKS5 proxies.

---

## Features

- ⚔️ **BedWars Stats Lookup**: Real-time stats retrieval directly inside Minecraft chat (`.stat <username> [mode] [interval]`).
- 🎨 **Dynamic Rank Colorization**: Automatically detects the player's server/network rank and colorizes their username using in-game hex colors (`Champion`, `Titan`, `Elite`, `VIP`, `Member`).
- 🔤 **Case-Insensitive Resolution**: Automatically resolves any username casing (e.g. `Zvwgvx` vs `zvwgvx`) to the exact canonical database record.
- 🛡️ **SOCKS5 Proxy Support**: Built-in SOCKS5 proxy routing with `ip:port:user:pass` authentication and automatic SRV record resolution.
- 🤖 **Automated Lobby Navigation**: Automatically handles `/login`, switches to the Server Selector, and joins the BedWars lobby upon connecting.
- ⏱️ **Spam Prevention**: Per-player cooldown to prevent chat flooding and API rate limits.

---

## Installation

```bash
# 1. Clone repository
git clone https://github.com/zvwgvx/pika-profiler.git
cd pika-profiler

# 2. Install dependencies
npm install

# 3. Create configuration file from template
cp .env.example .env
```

---

## Configuration (`.env`)

Edit your `.env` file with your bot credentials:

| Variable | Description | Default |
|:---|:---|:---|
| `MC_USERNAME` | Bot account username | *(Required)* |
| `SERVER_PASSWORD` | Password used for in-game `/login` | *(Required)* |
| `MC_AUTH` | Authentication mode (`offline` or `microsoft`) | `offline` |
| `MC_HOST` | Minecraft server host | `play.pika-network.net` |
| `MC_PORT` | Minecraft server port | `25565` |
| `MC_VERSION` | Game client version | `1.20.1` |
| `SOCKS5_PROXY` | SOCKS5 proxy (`ip:port:user:pass` or `ip:port`) | *(Optional)* |
| `CMD_PREFIX` | Prefix for bot commands | `.` |
| `DEFAULT_INTERVAL` | Default timeframe (`total` \| `monthly` \| `weekly`) | `total` |
| `DEFAULT_MODE` | Default game mode (`ALL_MODES` \| `SOLO` \| `DOUBLES` \| `QUADS`) | `ALL_MODES` |

---

## Running the Bot

```bash
# Production mode
npm start

# Development mode (auto-restart on file changes)
npm run dev
```

---

## In-Game Usage

Trigger the bot inside guild chat (`/g c`):

```text
.stat <username> [mode] [interval]
```

### Parameters

| Argument | Valid Values | Description | Default |
|:---|:---|:---|:---|
| `username` | Any player IGN | Target player to inspect | Message sender |
| `mode` | `1` (Solo), `2` (Doubles), `4` (Quads) | BedWars mode | All modes |
| `interval` | `week`, `month`, `year` | Stats timeframe | Lifetime (`total`) |

### Examples

```text
.stat Notch                # All modes, lifetime stats
.stat Notch 1              # Solo mode, lifetime stats
.stat Notch 2 month        # Doubles mode, monthly stats
.stat Notch 4 week         # Quads mode, weekly stats
```

### Output Preview

```text
Notch | Doubles Weekly | W: 15 WLR: 7.50 | K: 66 KDR: 4.71 | FK: 64 FKDR: 32.00
```

- **Player Name**: Rendered in their active rank color (Champion: Red, Titan: Yellow, Elite: Aqua, VIP: Green, Unranked: Gray).
- **Mode & Interval Tags**: Displayed cleanly only when different from default.
- **Key Metrics**: Wins (W), Win/Loss Ratio (WLR), Kills (K), Kill/Death Ratio (KDR), Final Kills (FK), Final Kill/Death Ratio (FKDR).

---

## Roadmap

- [x] BedWars stats checker with guild chat integration
- [x] Dynamic rank color detection & hex palette
- [x] Case-insensitive canonical username resolution
- [x] SOCKS5 proxy integration with authentication
- [ ] Denicker (unmasking nicked players using game recaps and skin data)
- [ ] Alt account detector & history tracking

---

## License

This project is licensed under the MIT License.
