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
let currentBot = null;
let reconnectTimer = null;
let isNavigating = false;
let navAttempts = 0;
const MAX_NAV_ATTEMPTS = 3;

// ─── Bot creation ───────────────────────────────────────────────────────────────
function createBot() {
  // Clean up any existing bot instance first
  if (currentBot) {
    try {
      currentBot.removeAllListeners();
      currentBot.end();
    } catch (_) {}
    currentBot = null;
  }

  botReady = false;
  isNavigating = false;

  const botOptions = {
    host:     CONFIG.host,
    port:     CONFIG.port,
    username: CONFIG.username,
    auth:     CONFIG.auth,
    version:  CONFIG.version,
    checkTimeoutInterval: 120 * 1000, // 2 minutes tolerance for proxy latency spikes
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
            // Enable TCP keepalive & disable Nagle to keep proxy NAT socket alive
            info.socket.setKeepAlive(true, 10000);
            info.socket.setNoDelay(true);
            client.setSocket(info.socket);
            client.emit('connect');
          });
        });
      };
    }
  }

  const bot = mineflayer.createBot(botOptions);
  currentBot = bot;

  // ── Anti-AFK & Heartbeat (prevents proxy idle timeout and server AFK kicks) ────
  const heartbeatTimer = setInterval(() => {
    if (!bot || !bot.entity || !bot._client || bot._client.ended) return;
    try {
      // 1. Slightly adjust view angle
      const yaw = bot.entity.yaw + (Math.random() * 0.1 - 0.05);
      bot.look(yaw, bot.entity.pitch, true);

      // 2. Sneak briefly to emit PlayerAction packet
      bot.setControlState('sneak', true);
      setTimeout(() => {
        try { if (bot.entity) bot.setControlState('sneak', false); } catch (_) {}
      }, 300);

      // 3. Swing arm occasionally
      if (Math.random() < 0.4) {
        bot.swingArm('right');
      }
    } catch (_) {}
  }, 15000);

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
    clearInterval(heartbeatTimer);
    console.log('[Bot] Connection ended.');
    botReady = false;
    isNavigating = false;
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

// ─── Helpers: Inventory & Navigation ───────────────────────────────────────────

function findHotbarSlot(bot, keywords) {
  for (let slot = 36; slot <= 44; slot++) {
    const item = bot.inventory?.slots?.[slot];
    if (!item) continue;
    const name = (item.name || '').toLowerCase();
    const displayName = (item.displayName || '').toLowerCase();
    for (const kw of keywords) {
      if (name.includes(kw) || displayName.includes(kw)) {
        return slot - 36; // 0-based quickbar slot
      }
    }
  }
  return null;
}

function isInBedwars(bot) {
  const hasLobbySelector = findHotbarSlot(bot, ['nether_star', 'lobby']) !== null;
  const hasServerSelector = findHotbarSlot(bot, ['server']) !== null;
  return hasLobbySelector && !hasServerSelector;
}

async function runLoginSequence(bot) {
  if (isNavigating) {
    console.log('[Nav] Navigation already in progress, skipping duplicate call.');
    return;
  }
  if (!bot || !bot._client || bot._client.ended) {
    console.log('[Nav] Bot not connected, aborting navigation.');
    return;
  }

  isNavigating = true;

  try {
    await sleep(2000);
    if (!bot || !bot._client || bot._client.ended) return;

    // Send /login
    console.log('[Login] Sending /login <password>…');
    bot.chat(`/login ${CONFIG.serverPassword}`);
    await sleep(2500);

    // Check if we need to navigate through Hub or if we are already in BedWars
    if (!isInBedwars(bot)) {
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow); } catch (_) {}
        await sleep(500);
      }

      const selectorSlot = findHotbarSlot(bot, ['compass', 'server']) ?? 4;
      console.log(`[Nav] Switching to Server Selector (slot index ${selectorSlot})…`);
      bot.setQuickBarSlot(selectorSlot);
      await sleep(600);

      console.log('[Nav] Activating Server Selector…');
      bot.activateItem();
      bot.swingArm('right');

      console.log('[Nav] Waiting for Server Selector menu…');
      const window = await waitForWindow(bot, 10000);
      console.log(`[Nav] Server Selector opened: "${window.title}" (${window.slots.length} slots)`);

      // Click slot [4,4] (row 4, col 4) = slot 30 (BedWars)
      const slotIndex = 30;
      console.log(`[Nav] Clicking slot ${slotIndex} (row 4, col 4) for BedWars…`);
      await sleep(500);
      bot.clickWindow(slotIndex, 0, 0);

      await sleep(3500);
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow); } catch (_) {}
      }
      console.log('[Nav] Joined BedWars lobby! Waiting for world to settle…');
      await sleep(4000);
    } else {
      console.log('[Nav] Already in BedWars! Skipping Hub selector.');
    }

    if (!bot || !bot._client || bot._client.ended) return;

    // ── Navigate to Lobby-1: Hotbar slot 7 -> open menu -> click [2,2] ──
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow); } catch (_) {}
      await sleep(500);
    }

    const lobbySlot = findHotbarSlot(bot, ['nether_star', 'lobby']) ?? 6;
    console.log(`[Nav] Switching to Lobby Selector (slot index ${lobbySlot})…`);
    bot.setQuickBarSlot(lobbySlot);
    await sleep(600);

    console.log('[Nav] Activating Lobby Selector…');
    bot.activateItem();
    bot.swingArm('right');

    console.log('[Nav] Waiting for Lobby Selector menu…');
    const lobbyWindow = await waitForWindow(bot, 10000);
    console.log(`[Nav] Lobby Selector opened: "${lobbyWindow.title}" (${lobbyWindow.slots.length} slots)`);

    // Click slot [2,2] (row 2, col 2) = slot 10 (Lobby-1)
    const lobbySlotIndex = 10;
    console.log(`[Nav] Clicking slot ${lobbySlotIndex} (row 2, col 2) for Lobby-1…`);
    await sleep(500);
    bot.clickWindow(lobbySlotIndex, 0, 0);

    await sleep(3000);
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow); } catch (_) {}
    }

    botReady = true;
    navAttempts = 0;
    console.log('[Nav] ✅ Joined BedWars Lobby-1! Bot is ready.');
  } catch (err) {
    console.error('[Nav] ❌ Navigation failed:', err.message);
    if (!bot || !bot._client || bot._client.ended) return;

    navAttempts++;
    if (navAttempts <= MAX_NAV_ATTEMPTS) {
      console.log(`[Nav] Retrying in 6s (attempt ${navAttempts}/${MAX_NAV_ATTEMPTS})…`);
      await sleep(6000);
      runLoginSequence(bot);
    } else {
      console.warn('[Nav] Max attempts reached, triggering clean bot restart…');
      navAttempts = 0;
      bot.end();
    }
  } finally {
    isNavigating = false;
  }
}

/**
 * Wait for a window (chest/menu) to open
 */
function waitForWindow(bot, timeout = 10000) {
  // If window is ALREADY open, return it immediately
  if (bot.currentWindow) {
    return Promise.resolve(bot.currentWindow);
  }

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      bot.removeListener('windowOpen', onOpen);
      if (!resolved) {
        if (bot.currentWindow) {
          resolve(bot.currentWindow);
        } else {
          reject(new Error(`Window did not open within ${timeout}ms`));
        }
      }
    }, timeout);

    function onOpen(window) {
      if (resolved) return;
      resolved = true;
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

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('[Bot] Reconnecting in 10s…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[Bot] Reconnecting now…');
    createBot();
  }, 10_000);
}

// ─── Process-level error protection ─────────────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[Process] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('[Process] Unhandled Rejection:', reason);
});

// ─── Start ──────────────────────────────────────────────────────────────────────
createBot();

