require('dotenv').config();
const fetch = require('node-fetch');

const DEFAULT_BASE_URL = 'https://stats.pika-network.net/api';

/**
 * Pika's stats API is authenticated: every request must carry a key in the
 * `X-Api-Key` header. Keys are issued in-game with `/apikey` and can be
 * revoked from the same command.
 */
function getApiKey() {
  return (process.env.PIKA_API_KEY || '').trim();
}

function getBaseUrl() {
  return (process.env.PIKA_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Build request headers (API key and defaults).
 */
function buildHeaders() {
  const headers = {
    'User-Agent': 'PikaStatBot/1.0',
    'Accept': 'application/json',
  };
  const key = getApiKey();
  if (key) headers['X-Api-Key'] = key;
  return headers;
}

/**
 * Perform an authenticated API request.
 * Throws API_KEY_MISSING, API_KEY_INVALID or RATE_LIMITED so the caller can
 * react to them; any other error status is left to the caller.
 */
async function apiRequest(path) {
  if (!getApiKey()) {
    throw new Error('API_KEY_MISSING');
  }

  const res = await fetch(`${getBaseUrl()}${path}`, { headers: buildHeaders() });

  if (res.status === 401) {
    throw new Error('API_KEY_INVALID');
  }
  if (res.status === 429) {
    throw new Error('RATE_LIMITED');
  }

  // Warn when the quota is nearly exhausted (limit is 120 requests / window)
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null && Number(remaining) <= 10) {
    console.warn(`[API] Rate limit running low: ${remaining}/${res.headers.get('x-ratelimit-limit')} left`);
  }

  return res;
}

// Mode mapping
// The API only accepts these mode identifiers. The quads mode is named
// "QUAD" (singular); a raw "QUADS" request is rejected with a 400.
const MODE_ALIASES = {
  ALL_MODES: 'ALL_MODES',
  SOLO: 'SOLO',
  DOUBLES: 'DOUBLES',
  QUAD: 'QUAD',
  QUADS: 'QUAD',
};

function normalizeApiMode(mode) {
  const key = String(mode || 'ALL_MODES').toUpperCase();
  return MODE_ALIASES[key] || key;
}

/**
 * Fetch Bedwars leaderboard stats for a player
 * @param {string} username
 * @param {string} interval - total | monthly | weekly | yearly
 * @param {string} mode - ALL_MODES | SOLO | DOUBLES | QUAD
 */
async function getBedwarsStats(username, interval = 'total', mode = 'ALL_MODES') {
  const url =
    `/profile/${encodeURIComponent(username)}/leaderboard` +
    `?type=bedwars&interval=${encodeURIComponent(interval)}&mode=${encodeURIComponent(normalizeApiMode(mode))}`;

  const res = await apiRequest(url);

  if (res.status === 404 || res.status === 204) return null; // player not found or no stats
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  return res.json();
}

/**
 * Fetch canonical profile and Bedwars stats with automatic casing normalization
 * (Pika leaderboard endpoint strictly requires canonical registration casing,
 * while /profile endpoint resolves any case and returns canonical profile.username)
 */
async function fetchPlayerStats(username, interval = 'total', mode = 'ALL_MODES') {
  // 1. Fetch profile first (case-insensitive on Pika)
  const profile = await getProfile(username);
  if (!profile) return { profile: null, data: null, canonicalName: username };

  // 2. Exact casing from database
  const canonicalName = profile.username || username;

  // 3. Fetch leaderboard stats using exact canonical casing
  const data = await getBedwarsStats(canonicalName, interval, mode);

  return { profile, data, canonicalName };
}

/**
 * Fetch basic player profile (rank, level, guild information).
 * @param {string} username
 */
async function getProfile(username) {
  const url = `/profile/${encodeURIComponent(username)}`;
  const res = await apiRequest(url);

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  return res.json();
}

/**
 * Extract a stat value from the leaderboard response object
 * @param {Object} data - raw API response
 * @param {string} key  - e.g. "Wins", "Losses", "Kills", "Deaths", "Finals", "Beds broken"
 */
function getStat(data, key) {
  if (!data || !data[key]) return 0;
  return data[key].entries?.[0]?.value ?? 0;
}

// Color palette (&#RRGGBB)
const C = {
  GOLD:   '&#FFB800',
  CYAN:   '&#00FFCC',
  PURPLE: '&#CC77FF',
  GRAY:   '&#AAAAAA',
  GREEN:  '&#55FF55',
  RED:    '&#FF5555',
  YELLOW: '&#FFFF55',
  WHITE:  '&#FFFFFF',
  RESET:  '',
};

// Rank colors for player names
const RANK_CONFIG = {
  owner:     { priority: 150, color: '&#FF5555' }, // red
  admin:     { priority: 140, color: '&#FF5555' }, // red
  developer: { priority: 130, color: '&#FF55FF' }, // pink/magenta
  srmod:     { priority: 120, color: '&#5555FF' }, // blue
  mod:       { priority: 110, color: '&#55FFFF' }, // aqua
  helper:    { priority: 105, color: '&#FFFF55' }, // yellow
  champion:  { priority: 100, color: '&#FF5555' }, // red
  titan:     { priority: 80,  color: '&#FFFF55' }, // yellow
  elite:     { priority: 60,  color: '&#55FFFF' }, // aqua
  vip:       { priority: 40,  color: '&#55FF55' }, // green
};

/**
 * Determine username color based on active server/global ranks
 */
function getPlayerRankColor(profile) {
  if (!profile || !Array.isArray(profile.ranks) || profile.ranks.length === 0) {
    return '&#AAAAAA'; // default unranked
  }

  const now = Date.now();
  let highest = { priority: 0, color: '&#AAAAAA' };

  for (const r of profile.ranks) {
    // Check expiry
    if (r.expiry && r.expiry > 0) {
      const expMs = r.expiry < 1e11 ? r.expiry * 1000 : r.expiry;
      if (expMs < now) continue;
    }

    // Only consider games, global or network ranks
    const s = (r.server || '').toLowerCase();
    if (s && s !== 'games' && s !== 'global' && s !== 'network') {
      continue;
    }

    const key = (r.displayName || r.name || '').toLowerCase();
    for (const [rankName, cfg] of Object.entries(RANK_CONFIG)) {
      if (key.includes(rankName) && cfg.priority > highest.priority) {
        highest = cfg;
      }
    }
  }

  return highest.color;
}

/**
 * Format Bedwars stats into a single colorful line for guild chat
 */
function formatBedwarsStats(username, data, interval, mode, profile = null) {
  const displayName = profile?.username || username;
  const nameColor = getPlayerRankColor(profile);
  if (!data) return `Player ${nameColor}${displayName} not found!`;

  const wins   = getStat(data, 'Wins');
  const losses = getStat(data, 'Losses');
  const kills  = getStat(data, 'Kills');
  const deaths = getStat(data, 'Deaths');
  const finals = getStat(data, 'Final kills');
  const fdeath = getStat(data, 'Final deaths');

  const wlr  = losses > 0 ? (wins / losses).toFixed(2) : wins.toString();
  const kdr  = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toString();
  const fkdr = fdeath > 0 ? (finals / fdeath).toFixed(2) : finals.toString();

  // Build tag: only show mode/interval when not default
  const tags = [];
  if (mode !== 'ALL_MODES') {
    const modeLabels = { SOLO: 'Solo', DOUBLES: 'Doubles', QUAD: 'Quads', QUADS: 'Quads' };
    tags.push(modeLabels[mode] || mode);
  }
  if (interval !== 'total') {
    const intLabels = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
    tags.push(intLabels[interval] || interval);
  }

  const sep = `${C.WHITE}|`;
  const tagPart = tags.length > 0 ? `${sep} ${C.PURPLE}${tags.join(' ')} ` : '';

  return (
    `${nameColor}${displayName} ` +
    tagPart +
    `${sep} ${C.GRAY}W: ${C.GREEN}${wins} ${C.GRAY}WLR: ${C.YELLOW}${wlr} ` +
    `${sep} ${C.GRAY}K: ${C.GREEN}${kills} ${C.GRAY}KDR: ${C.YELLOW}${kdr} ` +
    `${sep} ${C.GRAY}FK: ${C.GREEN}${finals} ${C.GRAY}FKDR: ${C.GOLD}${fkdr}`
  );
}

module.exports = {
  getBedwarsStats,
  getProfile,
  fetchPlayerStats,
  getPlayerRankColor,
  formatBedwarsStats,
  normalizeApiMode,
};
