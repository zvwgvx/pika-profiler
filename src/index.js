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
      const targetHost = !err && addresses && addresses.length > 0 ? addresses[0].name : host;
      const targetPort = !err && addresses && addresses.length > 0 ? addresses[0].port : port;
      dns.lookup(targetHost, { family: 4 }, (lookupErr, address) => {
        resolve({ host: !lookupErr && address ? address : targetHost, port: targetPort });
      });
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
let botReady = false;
let heartbeatTimer = null;
let watchdogTimer = null;
let readyTimer = null;
let lastPacketAt = 0;
let reconnectFailures = 0;
const MAX_NAV_ATTEMPTS = 3;
const MIN_RECONNECT_MS = 10000;
const MAX_RECONNECT_MS = 300000;
const PACKET_STALL_MS = 90000;
const READY_TIMEOUT_MS = 120000;

function clearBotTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (readyTimer) clearTimeout(readyTimer);
    heartbeatTimer = null;
    watchdogTimer = null;
    readyTimer = null;
}

function stopCurrentBot() {
    clearBotTimers();
    if (!currentBot) {
        botReady = false;
        isNavigating = false;
        return;
    }
    const bot = currentBot;
    currentBot = null;
    botReady = false;
    isNavigating = false;
    try { bot.removeAllListeners(); } catch (_) {}
    try { bot.end(); } catch (_) {}
}

function reconnectDelay(baseDelay) {
    const exponential = MIN_RECONNECT_MS * (2 ** Math.min(reconnectFailures, 5));
    return Math.min(MAX_RECONNECT_MS, Math.max(baseDelay, exponential)) + Math.floor(Math.random() * 3000);
}

function scheduleReconnect(baseDelay = MIN_RECONNECT_MS) {
    if (reconnectTimer) return;
    const delay = reconnectDelay(baseDelay);
    reconnectFailures++;
    console.log(`[Bot] Reconnecting in ${Math.round(delay / 1000)}s…`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        console.log('[Bot] Reconnecting now…');
        createBot();
    }, delay);
}

function forceReconnect(bot, reason, baseDelay = MIN_RECONNECT_MS) {
    if (currentBot !== bot) return;
    console.warn(`[Bot] Resetting connection: ${reason}`);
    stopCurrentBot();
    scheduleReconnect(baseDelay);
}

function kickReconnectDelay(reason) {
    const text = reason.toLowerCase();
    if (text.includes('too many connections')) return 180000;
    if (text.includes('already logged')) return 60000;
    if (text.includes('verify your connection') || text.includes('verification')) return 300000;
    if (text.includes('timeout') || text.includes('timed out')) return 30000;
    return 15000;
}

// ─── Bot creation ───────────────────────────────────────────────────────────────
function createBot() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    stopCurrentBot();
    botReady = false;
    isNavigating = false;

  const botOptions = {
    host:     CONFIG.host,
    port:     CONFIG.port,
    username: CONFIG.username,
    auth:     CONFIG.auth,
    version:  CONFIG.version,
    checkTimeoutInterval: 90000,
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
            timeout: 15000,
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
  lastPacketAt = Date.now();

  bot._client.on('packet', () => {
    if (currentBot === bot) lastPacketAt = Date.now();
  });

  heartbeatTimer = setInterval(() => {
    if (currentBot !== bot || !botReady || !bot.entity || !bot._client || bot._client.ended) return;
    try {
      const yaw = bot.entity.yaw + (Math.random() * 0.08 - 0.04);
      bot.look(yaw, bot.entity.pitch, true);
    } catch (_) {}
  }, 30000);

  watchdogTimer = setInterval(() => {
    if (currentBot !== bot || !bot._client || bot._client.ended) return;
    const stalledFor = Date.now() - lastPacketAt;
    if (stalledFor > PACKET_STALL_MS) forceReconnect(bot, `no packets for ${Math.round(stalledFor / 1000)}s`, 30000);
  }, 15000);

  readyTimer = setTimeout(() => {
    if (currentBot === bot && !botReady) forceReconnect(bot, 'ready timeout', 30000);
  }, READY_TIMEOUT_MS);

  bot.on('login', () => {
    lastPacketAt = Date.now();
    console.log(`[Bot] Connected as ${bot.username}`);
  });

  bot.on('error', err => {
    console.error('[Bot] Error:', err.message);
    forceReconnect(bot, `error: ${err.message}`, 30000);
  });

  let isBanned = false;

  bot.on('kicked', reason => {
    console.warn('[Bot] Kicked:', reason);
    const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
    if (reasonStr.toLowerCase().includes('banned')) {
      isBanned = true;
      clearBotTimers();
      console.error('[Bot] Account is banned on this server. Will NOT reconnect.');
      return;
    }
    forceReconnect(bot, 'kicked', kickReconnectDelay(reasonStr));
  });

  bot.on('end', () => {
    if (currentBot !== bot) return;
    clearBotTimers();
    currentBot = null;
    botReady = false;
    isNavigating = false;
    console.log('[Bot] Connection ended.');
    if (!isBanned) scheduleReconnect(15000);
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

function isBotConnected(bot) {
  return currentBot === bot && bot && bot._client && !bot._client.ended;
}

async function openMenu(bot, slot, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!isBotConnected(bot)) throw new Error('Bot disconnected');
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow); } catch (_) {}
      await sleep(400);
    }
    bot.setQuickBarSlot(slot);
    await sleep(700);
    bot.activateItem();
    bot.swingArm('right');
    try {
      return await waitForWindow(bot, 15000);
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        console.warn(`[Nav] ${label} did not open, retrying activation…`);
        await sleep(2000);
      }
    }
  }
  throw lastError || new Error(`${label} did not open`);
}

async function runLoginSequence(bot) {
  if (isNavigating) return;
  if (!isBotConnected(bot)) return;
  isNavigating = true;

  try {
    await sleep(2000);
    if (!isBotConnected(bot)) return;
    console.log('[Login] Sending /login <password>…');
    bot.chat(`/login ${CONFIG.serverPassword}`);
    await sleep(2500);

    for (let attempt = 1; attempt <= MAX_NAV_ATTEMPTS; attempt++) {
      try {
        if (!isBotConnected(bot)) return;

        if (!isInBedwars(bot)) {
          const selectorSlot = findHotbarSlot(bot, ['compass', 'server']) ?? 4;
          console.log(`[Nav] Opening Server Selector (slot index ${selectorSlot})…`);
          const window = await openMenu(bot, selectorSlot, 'Server Selector');
          console.log(`[Nav] Server Selector opened: "${window.title}" (${window.slots.length} slots)`);
          await sleep(500);
          bot.clickWindow(30, 0, 0);
          await sleep(4500);
          if (bot.currentWindow) {
            try { bot.closeWindow(bot.currentWindow); } catch (_) {}
          }
          await sleep(2500);
        }

        if (!isBotConnected(bot)) return;
        const lobbySlot = findHotbarSlot(bot, ['nether_star', 'lobby']) ?? 6;
        console.log(`[Nav] Opening Lobby Selector (slot index ${lobbySlot})…`);
        const lobbyWindow = await openMenu(bot, lobbySlot, 'Lobby Selector');
        console.log(`[Nav] Lobby Selector opened: "${lobbyWindow.title}" (${lobbyWindow.slots.length} slots)`);
        await sleep(500);
        bot.clickWindow(10, 0, 0);
        await sleep(3500);
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch (_) {}
        }

        if (!isBotConnected(bot)) return;
        botReady = true;
        reconnectFailures = 0;
        lastPacketAt = Date.now();
        if (readyTimer) {
          clearTimeout(readyTimer);
          readyTimer = null;
        }
        console.log('[Nav] ✅ Joined BedWars Lobby-1! Bot is ready.');
        return;
      } catch (err) {
        console.error(`[Nav] ❌ Attempt ${attempt}/${MAX_NAV_ATTEMPTS} failed:`, err.message);
        if (!isBotConnected(bot)) return;
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch (_) {}
        }
        if (attempt < MAX_NAV_ATTEMPTS) await sleep(5000 * attempt);
      }
    }

    forceReconnect(bot, 'navigation failed repeatedly', 30000);
  } finally {
    if (currentBot === bot) isNavigating = false;
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

// ─── Process-level error protection ─────────────────────────────────────────────
function fatalExit(label, reason) {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error(`[Process] ${label}:`, detail);
  stopCurrentBot();
  setTimeout(() => process.exit(1), 500).unref();
}

process.on('uncaughtException', err => fatalExit('Uncaught Exception', err));
process.on('unhandledRejection', reason => fatalExit('Unhandled Rejection', reason));

// ─── Start ──────────────────────────────────────────────────────────────────────
createBot();

