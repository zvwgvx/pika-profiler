const fetch = require('node-fetch');

const BASE_URL = 'https://stats.pika-network.net/api';

/**
 * Fetch Bedwars leaderboard stats for a player
 * @param {string} username
 * @param {string} interval - total | monthly | weekly
 * @param {string} mode - ALL_MODES | SOLO | DOUBLES | TRIPLES | QUADS
 */
async function getBedwarsStats(username, interval = 'total', mode = 'ALL_MODES') {
  const url = `${BASE_URL}/profile/${encodeURIComponent(username)}/leaderboard?type=bedwars&interval=${interval}&mode=${mode}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PikaStatBot/1.0' }
  });

  if (res.status === 404 || res.status === 204) return null; // player not found or no stats
  if (res.status === 429) throw new Error('RATE_LIMITED');
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
 * Fetch basic player profile (rank, level, guild…)
 * @param {string} username
 */
async function getProfile(username) {
  const url = `${BASE_URL}/profile/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PikaStatBot/1.0' }
  });

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

// ─── Color palette (&#RRGGBB) ────────────────────────────────────────────────────
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

// ─── Rank colors for player names ───────────────────────────────────────────────
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
    const modeLabels = { SOLO: 'Solo', DOUBLES: 'Doubles', QUADS: 'Quads' };
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

module.exports = { getBedwarsStats, getProfile, fetchPlayerStats, getPlayerRankColor, formatBedwarsStats };
