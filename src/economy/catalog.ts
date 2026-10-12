/**
 * The .online economy catalog — the ONE server-side list of what exists, what
 * it costs, and what every reward grants (2026-10-11, .online R2: C7 / C8 /
 * ECON-6 / ECON-7 / ECON-16 / APPUI-5 / APPUI-6 / APPUI-37 / APPUI-38).
 *
 * Before R2 the prices lived inline in index.ts, the Battle Pass and Career
 * rewards granted ids that existed in NO catalog (`avatar_frame/diamond`,
 * `emote/legendary_pack`, `title/season_champion`, `career_*`), the legacy
 * ThemeShop charged a flat `?? 400` for any theme id, and equipItem accepted any
 * (type, id) a client named. Every grant now names a real catalog item, and
 * every ownership / equip / emote decision is checked against this file.
 *
 * Play money only: stars and chips are never bought or cashed out.
 *
 * Client contract (K1/K2 own the rendering): every (type, id) here that a
 * player can own is rendered by the client's CSS catalog; `catalogForClient()`
 * is what the `getShopCatalog` socket request returns.
 */

// ───────────────────────────── Item types ─────────────────────────────

/** Item types a player can own (user_inventory.item_type). */
export const ITEM_TYPES = [
  'card_back', 'theme', 'frame', 'emote', 'celebration', 'sound_pack', 'title',
  'chip_skin', 'card_front', 'dealer_voice', 'profile_bg', 'badge',
] as const;
export type ItemType = typeof ITEM_TYPES[number];

/**
 * Types with one EQUIPPED item at a time (user_inventory.equipped). Emotes are
 * not equipped: every owned emote is usable (C7 `equipped.emotes`).
 */
export const EQUIPPABLE_TYPES: ReadonlySet<string> = new Set<ItemType>([
  'card_back', 'theme', 'frame', 'title', 'chip_skin', 'card_front', 'dealer_voice',
  'profile_bg', 'sound_pack', 'celebration', 'badge',
]);

/** Legacy / alias item types → the catalog type (grants made before R2 used `avatar_frame`). */
const TYPE_ALIASES: Record<string, ItemType> = {
  avatar_frame: 'frame',
  cardback: 'card_back',
  table_theme: 'theme',
};

export function normalizeItemType(t: unknown): string {
  const s = String(t ?? '').trim();
  return TYPE_ALIASES[s] ?? s;
}

// ───────────────────────────── Shop prices (stars) ─────────────────────────────

/** Server-authoritative shop prices in STARS. The client can never influence a cost. */
export const SHOP_PRICES: Record<string, Record<string, number>> = {
  // Card backs
  card_back: {
    classic_red: 0, royal_blue: 0,
    gold_premium: 500, neon_green: 500, silver_foil: 400,
    holographic: 800, dragon: 1200, phoenix: 1500,
    diamond_pattern: 2000, mythic: 5000,
  },
  // Table themes
  theme: {
    classic_blue: 0, green_felt: 0,
    midnight_purple: 300, ocean_breeze: 400, casino_royale: 500,
    neon_vegas: 600, carbon_black: 700, royal_gold: 800,
    cherry_wood: 900, cosmic_nebula: 1500,
  },
  // Nameplate / avatar frames
  frame: {
    bronze: 500, silver: 1000, gold: 2000, diamond: 5000,
    flame: 6000, ice: 6000, crown: 10000, platinum: 8000, mythic: 15000,
  },
  // Emotes. R3 (E1 / K2-3) — `fire` and `dead` are not sold: they are FREE
  // wheel emotes every account already has (FREE_EMOTES); the shop listed them
  // at 250 / 300 stars and every purchase was refused `already_owned`.
  emote: {
    nice_hand: 150, good_game: 150, well_played: 150,
    thumbs_up: 150, clap: 200, love: 250,
    big_brain: 200, money: 200,
    tears: 250, rocket: 300, crown: 400,
    sunglasses: 200, laughing: 200, surprised: 200,
    think: 300, poker_face: 400,
    mic_drop: 500, trophy: 600,
  },
  // Celebrations
  celebration: {
    confetti: 400, chip_rain: 800, fireworks: 1200, lightning: 1500,
    golden_shower: 2000, dragon_breath: 3000, cosmic_burst: 4000, supernova: 6000,
  },
  // Sound packs
  sound_pack: {
    silent_mode: 100, classic_casino: 300, vegas_casino: 300,
    old_school: 500, cyberpunk: 750, fantasy: 1000,
  },
  // Player titles
  title: {
    nitwit: 300, calling_station: 400, grinder: 500,
    river_rat: 600, chip_leader: 700, degenerate: 700,
    the_shark: 800, bad_beat_survivor: 800, final_table: 1000,
    bluff_master: 1200, all_in_legend: 1500, phantom: 1500,
    tournament_champ: 2000, royal: 3000, godmode: 8000,
  },
  // Chip packs — stars → chips (no inventory row)
  chip_pack: {
    refill: 50, small: 100, medium: 300, big: 600,
    pro: 1500, whale: 3000, kingpin: 6000, emperor: 12000,
  },
  // Mystery boxes — stars → a random reward
  mystery_box: {
    basic: 500, premium: 2000, legendary: 8000,
  },
  // Chip skins
  chip_skin: {
    classic: 0, crimson: 400, cobalt: 500, emerald: 600,
    amethyst: 800, gold_rimmed: 1200, neon: 1800, holographic: 2500, mythic: 4000,
  },
  // Card fronts
  card_front: {
    standard: 0, minimal: 400, retro: 600, modern: 800,
    futuristic: 1200, luxury: 1800, hanafuda: 2200, artistic: 2800,
  },
  // Dealer voice packs
  dealer_voice: {
    standard: 0, vegas_vet: 600, british_butler: 800,
    pirate: 900, robot: 1100, sportscaster: 1400, celebrity: 2200, mythic_sage: 4000,
  },
  // Profile backgrounds
  profile_bg: {
    default: 0, sunset: 200, city_lights: 350, deep_space: 500,
    aurora: 700, volcano: 900, underwater: 1100, cherry_blossom: 1400, diamond_rain: 2500,
  },
  // XP & chip boosters (consumables)
  booster: {
    xp_2x_15m: 200, xp_2x_1h: 600, xp_2x_1d: 2500,
    chip_1p5x_1h: 400, chip_1p5x_1d: 2000,
  },
  // VIP passes
  vip_pass: {
    daily: 300, weekly: 1500, monthly: 5000, lifetime: 50000,
  },
  // Bundles (BUNDLE_CONTENTS)
  bundle: {
    starter: 800, collector: 2500, tournament: 4000, whale_bundle: 10000, mythic_bundle: 25000,
  },
};

/** Chips paid out by each chip pack. */
export const CHIP_PACK_PAYOUT: Record<string, number> = {
  refill: 10000, small: 25000, medium: 100000, big: 250000,
  pro: 750000, whale: 2000000, kingpin: 5000000, emperor: 15000000,
};

/**
 * R3 (E1 — ECON-6 / APPUI-5) — the cosmetic types the client RENDERS (table
 * theme, card back, nameplate frame, title, emote wheel). Nothing sold or
 * granted may be inert: a bundle, a mystery-box pool and the scratch emote pool
 * hold only these types. Celebration / sound pack / chip skin / card front /
 * dealer voice rows a player already owns stay in his inventory (collectibles).
 */
export const RENDERED_ITEM_TYPES: ReadonlySet<string> = new Set<ItemType>(['theme', 'card_back', 'frame', 'title', 'emote']);

/**
 * R3 review (SF-B-1) — what the SHOP sells: the rendered table cosmetics plus
 * profile backgrounds (drawn on the lobby banner and the profile page, so not
 * inert). Bundles and the mystery / scratch pools stay on RENDERED_ITEM_TYPES.
 */
export const SOLD_COSMETIC_TYPES: ReadonlySet<string> = new Set<string>([...RENDERED_ITEM_TYPES, 'profile_bg']);

/**
 * What a bundle grants. A duplicate refunds 25% of the bundle price pro rata in stars.
 * R3 (E1) — every item is a RENDERED type; each celebration / sound pack /
 * dealer voice / chip skin / card front / profile background a bundle used to
 * hold was replaced 1:1 by a rendered catalog item of a similar price:
 *   collector  chip_rain 800 → title bad_beat_survivor 800
 *   tournament fireworks 1200 → title final_table 1000
 *   whale      golden_shower 2000 → title tournament_champ 2000, fantasy 1000 →
 *              theme cherry_wood 900, celebrity 2200 → frame gold 2000
 *   mythic     supernova 6000 → frame flame 6000, chip_skin mythic 4000 → frame
 *              diamond 5000, card_front artistic 2800 → title royal 3000,
 *              mythic_sage 4000 → card_back diamond_pattern 2000, diamond_rain
 *              2500 → title tournament_champ 2000
 */
export const BUNDLE_CONTENTS: Record<string, Array<[ItemType, string]>> = {
  starter: [['card_back', 'silver_foil'], ['emote', 'nice_hand'], ['frame', 'bronze']],
  collector: [['card_back', 'gold_premium'], ['theme', 'casino_royale'], ['frame', 'silver'], ['emote', 'crown'], ['title', 'bad_beat_survivor']],
  tournament: [['title', 'tournament_champ'], ['theme', 'royal_gold'], ['frame', 'gold'], ['card_back', 'holographic'], ['title', 'final_table'], ['emote', 'trophy']],
  whale_bundle: [['theme', 'cosmic_nebula'], ['card_back', 'diamond_pattern'], ['frame', 'diamond'], ['title', 'tournament_champ'], ['emote', 'mic_drop'], ['title', 'royal'], ['theme', 'cherry_wood'], ['frame', 'gold']],
  mythic_bundle: [['card_back', 'mythic'], ['frame', 'mythic'], ['title', 'godmode'], ['frame', 'flame'], ['frame', 'diamond'], ['title', 'royal'], ['card_back', 'diamond_pattern'], ['title', 'tournament_champ'], ['theme', 'cosmic_nebula']],
};

// ───────────────────────────── Boosters ─────────────────────────────

/**
 * Consumable boosters. `xp` multiplies XP earned; `chip` multiplies CHIP REWARD
 * GRANTS ONLY — level-up rewards, achievements, missions, the daily login
 * reward, the daily spin and scratch cards (`CHIP_BOOSTED_REWARDS`). It NEVER
 * touches pot winnings (that would mint chips out of a table). Buying a booster
 * of a kind that is still running EXTENDS it (time is added, never lost).
 */
export const BOOSTER_DURATION: Record<string, { kind: 'xp' | 'chip'; mult: number; ms: number }> = {
  xp_2x_15m:    { kind: 'xp',   mult: 2,   ms: 15 * 60 * 1000 },
  xp_2x_1h:     { kind: 'xp',   mult: 2,   ms: 60 * 60 * 1000 },
  xp_2x_1d:     { kind: 'xp',   mult: 2,   ms: 24 * 60 * 60 * 1000 },
  chip_1p5x_1h: { kind: 'chip', mult: 1.5, ms: 60 * 60 * 1000 },
  chip_1p5x_1d: { kind: 'chip', mult: 1.5, ms: 24 * 60 * 60 * 1000 },
};

/** The reward grants a chip booster multiplies (reported to the client for its copy). */
export const CHIP_BOOSTED_REWARDS = ['level_up', 'achievement', 'mission', 'daily_login', 'daily_spin', 'scratch_card'] as const;

// ───────────────────────────── VIP (C8) ─────────────────────────────

export const VIP_PASS_DURATION: Record<string, number> = {
  daily:    24 * 60 * 60 * 1000,
  weekly:   7 * 24 * 60 * 60 * 1000,
  monthly:  30 * 24 * 60 * 60 * 1000,
  lifetime: 100 * 365 * 24 * 60 * 60 * 1000,
};

/** C8 — the daily login reward (chips + stars) while a VIP pass is active: +50%. */
export const VIP_LOGIN_MULTIPLIER = 1.5;
/** C8 — the monthly VIP chip bonus, claimable once per Denver month while a pass is active (`claimVipMonthly`). */
export const VIP_MONTHLY_BONUS_CHIPS = 25_000;
/** C8 — emotes only an active VIP pass unlocks. */
export const VIP_EMOTES: readonly string[] = ['vip_crown', 'vip_diamond', 'vip_champagne'];

/** C8 perk ids (what `vip.perks` lists while they apply). */
export const VIP_PASS_PERKS = ['vip_badge', 'gold_frame', 'login_bonus_50', 'monthly_chips', 'vip_emotes'] as const;

/**
 * The XP-rate multiplier (unchanged from before R2: it applies to every player
 * by cumulative season XP — the loyalty tier the VIPPanel shows).
 */
export const VIP_XP_TIERS: ReadonlyArray<{ name: string; minXp: number; rate: number }> = [
  { name: 'Platinum', minXp: 20000, rate: 3 },
  { name: 'Gold', minXp: 5000, rate: 2 },
  { name: 'Silver', minXp: 1000, rate: 1.5 },
  { name: 'Bronze', minXp: 0, rate: 1 },
];
export function vipTierForSeasonXp(totalXp: number): { name: string; rate: number } {
  const xp = Number(totalXp) || 0;
  for (const t of VIP_XP_TIERS) if (xp >= t.minXp) return { name: t.name, rate: t.rate };
  return { name: 'Bronze', rate: 1 };
}

// ───────────────────────────── Emotes ─────────────────────────────

/** The emote wheel's always-free emotes (poker-3d EmoteWheel `kind:'emote'`). */
export const FREE_EMOTES: readonly string[] = ['nice', 'lol', 'cool', 'angry', 'thinking', 'dead', 'fire', 'gg'];
/** Table reactions (`tableReaction`), always free. */
export const FREE_REACTIONS: readonly string[] = ['clap', 'laugh', 'cry', 'shock'];

// ───────────────────────────── Badges (C9) ─────────────────────────────

/** Season award badges (type 'badge') — never sold; granted by the monthly season award. */
export const SEASON_BADGES: Record<string, { name: string; place: number }> = {
  season_gold: { name: 'Season Champion (Gold)', place: 1 },
  season_silver: { name: 'Season Runner-up (Silver)', place: 2 },
  season_bronze: { name: 'Season Third (Bronze)', place: 3 },
};

// ───────────────────────────── Catalog lookups ─────────────────────────────

/** Items that exist but are never sold (rewards only). */
const REWARD_ONLY: Record<string, Set<string>> = {
  badge: new Set(Object.keys(SEASON_BADGES)),
  emote: new Set(VIP_EMOTES),
};

/** Is (type, id) an OWNABLE catalog item (cosmetic — not a chip pack, box, booster, pass or bundle)? */
export function isOwnableItem(type: unknown, id: unknown): boolean {
  const t = normalizeItemType(type);
  const i = String(id ?? '');
  if (!(ITEM_TYPES as readonly string[]).includes(t) || !i) return false;
  if (REWARD_ONLY[t]?.has(i)) return true;
  return Object.prototype.hasOwnProperty.call(SHOP_PRICES[t] || {}, i);
}

/** The star price of a sellable (type, id), else null. */
export function shopPrice(type: unknown, id: unknown): number | null {
  const t = String(type ?? '');
  const i = String(id ?? '');
  const prices = SHOP_PRICES[t];
  if (!prices || !Object.prototype.hasOwnProperty.call(prices, i)) return null;
  const p = prices[i];
  return Number.isInteger(p) && p >= 0 ? p : null;
}

/** A free (price 0) cosmetic — owned by everyone, equippable without an inventory row. */
export function isFreeItem(type: unknown, id: unknown): boolean {
  return isOwnableItem(type, id) && shopPrice(normalizeItemType(type), id) === 0;
}

/**
 * An item EVERY account can already use: a free (price 0) catalog item, or one
 * of the emote wheel's free emotes (FREE_EMOTES). R3 (E1): the shop no longer
 * lists `fire` / `dead` and no pool rolls them; a purchase request for one is
 * still refused `already_owned` (never a charge for nothing), and a roll that
 * ever lands on a free item pays the duplicate stars instead.
 */
export function isFreeForEveryone(type: unknown, id: unknown): boolean {
  return isFreeItem(type, id) || (normalizeItemType(type) === 'emote' && FREE_EMOTES.includes(String(id ?? '')));
}

export const itemKey = (type: string, id: string): string => `${normalizeItemType(type)}:${id}`;

// ───────────────────────────── Random rewards ─────────────────────────────

/** A random source in [0, 1) — injectable so tests can pin every roll. */
export type Rng = () => number;

export type RewardRoll =
  | { kind: 'chips'; amount: number }
  | { kind: 'stars'; amount: number }
  | { kind: 'item'; itemType: ItemType; itemId: string };

/**
 * Mystery box tiers (shop + the Day-7 login box, which is a 'basic' box).
 * R3 (E1 / K2-7) — RENDERED types only, 1:1 replacements of a similar price:
 * basic fire (free) → emote tears 250, sound_pack classic_casino 300 → emote
 * rocket 300 (the basic item roll is now always an emote); premium celebration
 * chip_rain 800 → title bad_beat_survivor 800; legendary celebration supernova
 * 6000 → frame flame 6000 (premium / legendary stay "a frame, title or card back").
 */
export const MYSTERY_BOX_TIERS: Record<string, { chips: [number, number]; stars: [number, number]; itemPool: Array<[ItemType, string]> }> = {
  basic: {
    chips: [5000, 25000], stars: [50, 150],
    itemPool: [['emote', 'nice_hand'], ['emote', 'tears'], ['emote', 'rocket']],
  },
  premium: {
    chips: [25000, 150000], stars: [200, 600],
    itemPool: [['frame', 'silver'], ['title', 'bad_beat_survivor'], ['title', 'the_shark'], ['card_back', 'holographic']],
  },
  legendary: {
    chips: [150000, 1000000], stars: [800, 2500],
    itemPool: [['frame', 'diamond'], ['frame', 'flame'], ['title', 'royal'], ['card_back', 'mythic']],
  },
};
/** A duplicate mystery-box item is refunded this share of the box price, in stars. */
export const MYSTERY_DUPLICATE_REFUND_SHARE = 0.4;

const between = (rng: Rng, lo: number, hi: number) => Math.floor(lo + rng() * (hi - lo));

/** 50% chips, 30% stars, 20% an item from the tier's pool. */
export function rollMysteryBox(tierId: string, rng: Rng = Math.random): RewardRoll {
  const tier = MYSTERY_BOX_TIERS[tierId] || MYSTERY_BOX_TIERS.basic;
  const roll = rng();
  if (roll < 0.5) return { kind: 'chips', amount: between(rng, tier.chips[0], tier.chips[1]) };
  if (roll < 0.8) return { kind: 'stars', amount: between(rng, tier.stars[0], tier.stars[1]) };
  const [itemType, itemId] = tier.itemPool[Math.min(tier.itemPool.length - 1, Math.floor(rng() * tier.itemPool.length))];
  return { kind: 'item', itemType, itemId };
}

/**
 * The daily spin's REAL prize table (APPUI-37 / ECON P3: the wheel used to draw
 * segments the server never paid). `getSpinWheel` sends exactly this; the claim
 * answers with the landed `segmentId`.
 */
export const SPIN_WHEEL_SEGMENTS: ReadonlyArray<{ id: string; label: string; chips: number; stars: number; weight: number }> = [
  { id: 'stars_100', label: '100 Stars', chips: 0, stars: 100, weight: 5 },
  { id: 'stars_25', label: '25 Stars', chips: 0, stars: 25, weight: 20 },
  { id: 'chips_2500', label: '2,500 Chips', chips: 2500, stars: 0, weight: 50 },
  { id: 'chips_10000', label: '10,000 Chips', chips: 10000, stars: 0, weight: 25 },
];
export function rollSpinWheel(rng: Rng = Math.random): typeof SPIN_WHEEL_SEGMENTS[number] {
  const total = SPIN_WHEEL_SEGMENTS.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const seg of SPIN_WHEEL_SEGMENTS) {
    if (r < seg.weight) return seg;
    r -= seg.weight;
  }
  return SPIN_WHEEL_SEGMENTS[SPIN_WHEEL_SEGMENTS.length - 1];
}

/**
 * Scratch card: 20% stars (10-49), 10% an emote from the pool, 70% chips (1,000-9,999).
 * R3 (E1) — sellable emotes only: `fire` (free for everyone) → `love` (250).
 */
export const SCRATCH_EMOTE_POOL: readonly string[] = ['nice_hand', 'good_game', 'love', 'crown'];
/** A scratch-card emote the player already owns pays this many stars instead. */
export const SCRATCH_DUPLICATE_STARS = 25;
export function rollScratchCard(rng: Rng = Math.random): RewardRoll {
  const roll = rng();
  if (roll < 0.2) return { kind: 'stars', amount: 10 + Math.floor(rng() * 40) };
  if (roll < 0.3) {
    const id = SCRATCH_EMOTE_POOL[Math.min(SCRATCH_EMOTE_POOL.length - 1, Math.floor(rng() * SCRATCH_EMOTE_POOL.length))];
    return { kind: 'item', itemType: 'emote', itemId: id };
  }
  return { kind: 'chips', amount: 1000 + Math.floor(rng() * 9000) };
}

// ───────────────────────────── Daily login (ECON-4) ─────────────────────────────

/** Day 1..7 of the streak cycle (index 0 unused). Day 7 also opens a basic Mystery Box. */
export const LOGIN_CHIPS_BY_DAY = [0, 1000, 2000, 3000, 5000, 7500, 10000, 20000];
export const LOGIN_STARS_BY_DAY = [0, 0, 0, 0, 5, 10, 20, 50];
export const LOGIN_DAY7_MYSTERY_BOX = 'basic';
/** The streak cycle day (1..7) for a streak length. */
export const loginCycleDay = (streak: number): number => ((Math.max(1, Math.floor(streak)) - 1) % 7) + 1;

// ───────────────────────────── Battle Pass (ECON-16) ─────────────────────────────

export const BATTLE_PASS_XP_PER_TIER = 500;
export const BATTLE_PASS_TOTAL_TIERS = 50;
export const BATTLE_PASS_PREMIUM_COST = 950;
export const BATTLE_PASS_SEASON_NAME = 'Season 1: The River';

// ───────────────────────────── Career (C7) ─────────────────────────────

/**
 * Career venue completion rewards, granted once per venue (final stage won).
 * The cosmetics are REAL catalog items (the career_* ids before R2 existed in
 * no catalog and rendered as nothing).
 */
export const CAREER_REWARDS: ReadonlyArray<{ chips: number; item?: [ItemType, string] }> = [
  { chips: 1000 },
  { chips: 5000, item: ['card_back', 'gold_premium'] },
  { chips: 15000, item: ['theme', 'royal_gold'] },
  { chips: 50000, item: ['frame', 'platinum'] },
  { chips: 100000, item: ['theme', 'cosmic_nebula'] },
  { chips: 500000, item: ['card_back', 'mythic'] },
];

// ───────────────────────────── Season awards (C9) ─────────────────────────────

export const SEASON_REWARDS: ReadonlyArray<{ place: number; chips: number; badge: string }> = [
  { place: 1, chips: 50000, badge: 'season_gold' },
  { place: 2, chips: 25000, badge: 'season_silver' },
  { place: 3, chips: 10000, badge: 'season_bronze' },
];

/**
 * R3 (XL-2) — the first Denver month the chips-won ledger (user_chip_wins,
 * created at the first R2 boot) measures. An earlier season was never
 * measured: it is never awarded and never MARKED awarded (the first R2 boot's
 * sweep used to record September 2026 as "awarded, 0 winners" over the empty
 * ledger, so it could never be paid). Paying a pre-ledger month is an owner
 * decision; leaving it unmarked keeps that possible.
 */
export const FIRST_CHIPS_WON_SEASON = '2026-10';

// ───────────────────────────── Alerts ─────────────────────────────

/** Any single economy credit at or above this many chips is logged as a LARGE CHIP GRANT ALERT. */
export const CHIP_GRANT_ALERT_THRESHOLD = 1_000_000;

// ───────────────────────────── Client view ─────────────────────────────

/** The `shopCatalog` payload: every sellable item with its price + every reward-only item. */
export function catalogForClient(): {
  prices: Record<string, Record<string, number>>;
  rewardOnly: Record<string, string[]>;
  freeEmotes: readonly string[];
  vipEmotes: readonly string[];
  bundles: Record<string, Array<[string, string]>>;
  chipPacks: Record<string, number>;
  boosters: Record<string, { kind: string; mult: number; minutes: number }>;
  vipPasses: Record<string, { days: number }>;
  chipBoostedRewards: readonly string[];
} {
  const boosters: Record<string, { kind: string; mult: number; minutes: number }> = {};
  for (const [id, b] of Object.entries(BOOSTER_DURATION)) boosters[id] = { kind: b.kind, mult: b.mult, minutes: Math.round(b.ms / 60000) };
  const vipPasses: Record<string, { days: number }> = {};
  for (const [id, ms] of Object.entries(VIP_PASS_DURATION)) vipPasses[id] = { days: Math.round(ms / 86_400_000) };
  const rewardOnly: Record<string, string[]> = {};
  for (const [t, ids] of Object.entries(REWARD_ONLY)) rewardOnly[t] = [...ids];
  return {
    prices: SHOP_PRICES,
    rewardOnly,
    freeEmotes: FREE_EMOTES,
    vipEmotes: VIP_EMOTES,
    bundles: BUNDLE_CONTENTS,
    chipPacks: CHIP_PACK_PAYOUT,
    boosters,
    vipPasses,
    chipBoostedRewards: CHIP_BOOSTED_REWARDS,
  };
}
