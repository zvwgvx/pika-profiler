require('dotenv').config();
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { fetchPlayerStats, formatBedwarsStats } = require('./api');

// ─── Utility: sleep & dns resolve ───────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function resolveServer(host, port) {
  return new Promise((resolve) => {
    dns.resolveSrv(`_minecraft._tcp.${host}`, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        resolve({ host: addresses[0].name, port: addresses[0].port });
      } else {
        resolve({ host, port });
      }
    });
  });
}

// ─── Config ─────────────────────────────────────────────────────────────────────
const CONFIG = {
  host:     process.env.MC_HOST     || 'play.pika-network.net',
  port:     parseInt(process.env.MC_PORT || '25565'),
  username: process.env.MC_USERNAME,
  auth:     process.env.MC_AUTH     || 'offline',
  version:  process.env.MC_VERSION  || '1.20.1',
  serverPassword: process.env.SERVER_PASSWORD,
  prefix:   process.env.CMD_PREFIX  || '.',
  defaultInterval: process.env.DEFAULT_INTERVAL || 'total',
  defaultMode:     process.env.DEFAULT_MODE     || 'ALL_MODES',
  socks5Proxy:     process.env.SOCKS5_PROXY || process.env.PROXY || '',
};

if (!CONFIG.username) {
  console.error('[ERROR] MC_USERNAME is not set in .env');
  process.exit(1);
}
if (!CONFIG.serverPassword) {
  console.error('[ERROR] SERVER_PASSWORD is not set in .env');
  process.exit(1);
}

/**
 * Parse SOCKS5 proxy string
 * Format supported: ip:port:user:pass or ip:port or socks5://user:pass@ip:port
 */
function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  let str = proxyStr.trim();
  if (str.includes('://')) str = str.split('://')[1];
  if (str.includes('@')) {
    const [auth, hostPort] = str.split('@');
    const [userId, password] = auth.split(':');
    const [host, portStr] = hostPort.split(':');
    return { host, port: parseInt(portStr, 10), userId, password };
  }
  const parts = str.split(':');
  if (parts.length >= 2) {
    return {
      host: parts[0],
      port: parseInt(parts[1], 10),
      userId: parts[2] || undefined,
      password: parts[3] || undefined,
    };
  }
  return null;
}

// ─── Chat log file ──────────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, '..', 'chat.log');

function logChat(raw, json) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${raw}\n    JSON: ${JSON.stringify(json)}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(`[Chat] ${raw}`);
}

// ─── Cooldown map ───────────────────────────────────────────────────────────────
const cooldowns = new Map();
const COOLDOWN_MS = 5000;

// ─── Bot state ──────────────────────────────────────────────────────────────────
let botReady = false;

// ─── Bot creation ───────────────────────────────────────────────────────────────
function createBot() {
  botReady = false;

  const botOptions = {
    host:     CONFIG.host,
    port:     CONFIG.port,
    username: CONFIG.username,
    auth:     CONFIG.auth,
    version:  CONFIG.version,
  };

  if (CONFIG.socks5Proxy) {
    const proxy = parseProxy(CONFIG.socks5Proxy);
    if (proxy) {
      console.log(`[Proxy] Connecting via SOCKS5: ${proxy.host}:${proxy.port}${proxy.userId ? ` (user: ${proxy.userId})` : ''}`);
      botOptions.connect = (client) => {
        const targetHost = client.options?.host || CONFIG.host;
        const targetPort = client.options?.port || CONFIG.port;
        resolveServer(targetHost, targetPort).then((dest) => {
          SocksClient.createConnection({
            proxy: {
              host: proxy.host,
              port: proxy.port,
              type: 5,
              userId: proxy.userId,
              password: proxy.password,
            },
            command: 'connect',
            destination: {
              host: dest.host,
              port: dest.port,
            },
          }, (err, info) => {
            if (err) {
              console.error('[Proxy Error]', err.message);
              client.emit('error', err);
              return;
            }
            client.setSocket(info.socket);
            client.emit('connect');
          });
        });
      };
    }
  }

  const bot = mineflayer.createBot(botOptions);

  // ── Events ────────────────────────────────────────────────────────────────────
  bot.on('login', () => {
    console.log(`[Bot] Connected as ${bot.username}`);
  });

  bot.on('error', err => {
    console.error('[Bot] Error:', err.message);
  });

  let isBanned = false;

  bot.on('kicked', reason => {
    console.warn('[Bot] Kicked:', reason);
    const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
    if (reasonStr.toLowerCase().includes('banned')) {
      isBanned = true;
      console.error('[Bot] Account is banned on this server. Will NOT reconnect.');
      return;
    }
    scheduleReconnect();
  });

  bot.on('end', () => {
    console.log('[Bot] Connection ended.');
    botReady = false;
    if (!isBanned) {
      scheduleReconnect();
    }
  });

  // ── Login sequence ────────────────────────────────────────────────────────────
  bot.once('spawn', () => {
    console.log('[Bot] Spawned, starting login…');
    runLoginSequence(bot);
  });

  // ── Chat listener (logs ALL messages + handles commands) ──────────────────────
  bot.on('message', async (jsonMsg, position) => {
    const raw = jsonMsg.toString();
    const json = jsonMsg.json ?? jsonMsg;

    // Log every single message to chat.log
    logChat(raw, json);

    // Don't process commands until ready
    if (!botReady) return;

    // Guild chat format: "Guilds ▏ <Rank> Username: msg" or "Guilds ▏ Username: msg"
    const guildMatch = raw.match(/^Guilds\s*▏\s*(?:<[^>]+>\s*)?(\w+)\s*:\s*(.+)$/i);
    if (!guildMatch) return;

    const sender  = guildMatch[1];
    const content = guildMatch[2].trim();

    if (!content.startsWith(CONFIG.prefix)) return;

    const args = content.slice(CONFIG.prefix.length).trim().split(/\s+/);
    const cmd  = args[0]?.toLowerCase();

    if (cmd !== 'stat') return;

    // ── Cooldown ─────────────────────────────────────────────────────
    const now = Date.now();
    const lastUsed = cooldowns.get(sender) || 0;
    if (now - lastUsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
      sendGuild(bot, `@${sender} Please wait ${remaining}s.`);
      return;
    }
    cooldowns.set(sender, now);

    // ── Parse: .stat <username> [mode] [interval] ────────────────────
    const target   = args[1] || sender;
    const mode     = normalizeMode(args[2])     || CONFIG.defaultMode;
    const interval = normalizeInterval(args[3]) || CONFIG.defaultInterval;

    console.log(`[Cmd] .stat ${target} ${mode} ${interval}  (by ${sender})`);

    try {
      const { profile, data, canonicalName } = await fetchPlayerStats(target, interval, mode);
      const message = formatBedwarsStats(canonicalName || target, data, interval, mode, profile);
      sendGuild(bot, message);
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        sendGuild(bot, 'API rate limited, try again later.');
      } else {
        console.error('[API Error]', err);
        sendGuild(bot, `Error fetching stats for ${target}.`);
      }
    }
  });

  return bot;
}

// 1. Wait for spawn
// 2. Switch to hotbar Server Selector → RMB → click BedWars in menu
// 3. Bot is ready

async function runLoginSequence(bot) {
  try {
    await sleep(2000);

    // Send /login
    console.log('[Login] Sending /login <password>…');
    bot.chat(`/login ${CONFIG.serverPassword}`);

    await sleep(2500);

    // Switch to hotbar slot 5 (Server Selector) and right-click
    console.log('[Nav] Switching to hotbar slot 5 (Server Selector)…');
    bot.setQuickBarSlot(4); // slot 5 = index 4 (0-based)

    await sleep(500);
    console.log('[Nav] Right-clicking Server Selector…');
    bot.activateItem();

    // Wait for menu window to open
    console.log('[Nav] Waiting for menu window…');
    const window = await waitForWindow(bot, 10000);
    console.log(`[Nav] Window opened: "${window.title}" (${window.slots.length} slots)`);

    // Log all slots so we can see what's in the menu
    for (let i = 0; i < window.slots.length; i++) {
      const slot = window.slots[i];
      if (slot) {
        console.log(`[Nav] Slot ${i}: ${slot.name} - "${slot.displayName}"`);
      }
    }

    // Click slot [4,4] (row 4, col 4) = (4-1)*9 + (4-1) = 30
    const slotIndex = (4 - 1) * 9 + (4 - 1); // = 30
    console.log(`[Nav] Clicking slot ${slotIndex} (row 4, col 4)…`);
    await sleep(500);
    bot.clickWindow(slotIndex, 0, 0);

    await sleep(3000);

    // Close window if still open
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
    }

    botReady = true;
    console.log('[Nav] ✅ Joined BedWars! Bot is ready.');
  } catch (err) {
    console.error('[Nav] ❌ Navigation failed:', err.message);
    console.log('[Nav] Retrying in 5s…');
    await sleep(5000);
    runLoginSequence(bot);
  }
}

/**
 * Wait for a window (chest/menu) to open
 */
function waitForWindow(bot, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeListener('windowOpen', onOpen);
      reject(new Error(`Window did not open within ${timeout}ms`));
    }, timeout);

    function onOpen(window) {
      clearTimeout(timer);
      resolve(window);
    }

    bot.once('windowOpen', onOpen);
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function sendGuild(bot, message) {
  bot.chat(`/g c ${message}`);
}

function normalizeInterval(str) {
  if (!str) return null;
  const map = {
    week: 'weekly', weekly: 'weekly', w: 'weekly',
    month: 'monthly', monthly: 'monthly', m: 'monthly',
    year: 'yearly', yearly: 'yearly', y: 'yearly',
  };
  return map[str.toLowerCase()] || null;
}

function normalizeMode(str) {
  if (!str) return null;
  const map = {
    '1': 'SOLO', solo: 'SOLO',
    '2': 'DOUBLES', doubles: 'DOUBLES', double: 'DOUBLES',
    '4': 'QUADS', quads: 'QUADS', quad: 'QUADS',
  };
  return map[str.toLowerCase()] || null;
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[Bot] Reconnecting…');
    createBot();
  }, 10_000);
}

// ─── Start ──────────────────────────────────────────────────────────────────────
createBot();
