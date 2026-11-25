/**
 * 2026-11-02 (.online tournament broadcast, P1-S1) — broadcast NAMES and the
 * opt-out CACHE (src/broadcast/broadcastNames.ts).
 *
 * Owner 2026-11-02: "First name + last initial, with a per-player opt-out to show
 * as Player". The rule runs on the server at emit time; unknown opt-out = 'Player'
 * (fail-closed); a bot is never opted out. pid is opaque (HMAC, per process, per
 * event) and never contains or equals the player id.
 */
import {
  broadcastNameOf, broadcastPid, optOutFromStats, createBroadcastOptOutStore, BROADCAST_NAME_FALLBACK,
} from '../src/broadcast/broadcastNames';

describe('broadcastNameOf — First L., aliases, the whitelist, fail-closed', () => {
  it('two words → "First L."; three words → first + LAST initial; one word unchanged', () => {
    expect(broadcastNameOf('John Smith', false)).toBe('John S.');
    expect(broadcastNameOf('Mary Ann Lee', false)).toBe('Mary L.');
    expect(broadcastNameOf('  josh   hall ', false)).toBe('josh H.');
    expect(broadcastNameOf("Dan O'Brien", false)).toBe('Dan O.');
    expect(broadcastNameOf('Zed', false)).toBe('Zed');
    expect(broadcastNameOf('AcesUp_77', false)).toBe('Aces U.');   // fix round 4: two joined words + digits
  });

  it('a phone-like value, a non-whitelist value, an over-20 name, a non-string → "Player"', () => {
    expect(broadcastNameOf('720-555-1234', false)).toBe('Player');
    expect(broadcastNameOf('5551234567', false)).toBe('Player');
    expect(broadcastNameOf('この地で最も', false)).toBe('Player');   // CJK (the 2026-05-13 incident)
    expect(broadcastNameOf('<b>Bold</b>', false)).toBe('Player');
    expect(broadcastNameOf('Averyveryverylongname Smith', false)).toBe('Player');
    expect(broadcastNameOf(undefined, false)).toBe('Player');
    expect(broadcastNameOf(42, false)).toBe('Player');
    expect(BROADCAST_NAME_FALLBACK).toBe('Player');
  });

  it('opted out → "Player"; opt-out UNKNOWN (undefined / null) → "Player" (fail-closed)', () => {
    expect(broadcastNameOf('John Smith', true)).toBe('Player');
    expect(broadcastNameOf('John Smith', undefined)).toBe('Player');
    expect(broadcastNameOf('John Smith', null)).toBe('Player');
  });

  it('a bot name passes (the caller passes optOut false for a bot)', () => {
    expect(broadcastNameOf('Bot Bluff', false)).toBe('Bot B.');
    expect(broadcastNameOf('Robo', false)).toBe('Robo');
  });

  it('every output passes the display-name whitelist (or is "Player")', () => {
    for (const raw of ['John Smith', 'a b', "O'Neil Jr.", 'Mary-Kate Olsen', 'x.y z', ' - . ', 'JohnSmith', 'JSmith', 'MaryJones22', 'TJMiller']) {
      const out = broadcastNameOf(raw, false);
      expect(out === 'Player' || /^[A-Za-z0-9 _.'-]{1,20}$/.test(out)).toBe(true);
    }
  });
});

/**
 * Owner 2026-11-02 (answer c): "Two joined capitalised words become first name +
 * initial". A one-word name (no space, '.' or '_') made of two or more capitalised
 * segments — letters only once trailing digits are stripped, at least one lowercase
 * letter — goes on air as "<first segment> <initial of the LAST segment>.". A leading
 * single-letter segment is an initial ("J."). The owner's rule is literal: an alias
 * made of capitalised words ("AcesUp") is shortened too. Fix round 4 widened it (see
 * the next block): every separator, digit and CamelCase boundary cuts, and a surname
 * prefix ("McDonald") stays one word.
 */
describe('broadcastNameOf — owner answer (c): joined capitalised words → "First L."', () => {
  it.each([
    ['JohnSmith', 'John S.'],
    ['JohnPaulJones', 'John J.'],
    ['MaryJones22', 'Mary J.'],          // trailing digits stripped first
    ['AcesUp', 'Aces U.'],               // the owner's literal rule: an alias of capitalised words too
    ['AcesUp7', 'Aces U.'],
    ['JSmith', 'J. S.'],                 // a leading single letter is an initial
    ['JohnQPublic', 'John P.'],          // the LAST segment's initial, not a middle one
    ['TJMiller', 'TJ M.'],               // a run of capitals before a word is one segment
    ['JohnSMITH', 'John S.'],            // an all-caps LAST segment is still a segment
    ['McDonald', 'McDonald'],            // fix round 4: a surname prefix joins the next segment (one word: as typed)
    ['  JohnSmith ', 'John S.'],         // trimmed by the display-name rules first
  ])('%j → %j', (raw, out) => {
    expect(broadcastNameOf(raw, false)).toBe(out);
  });

  it.each([
    ['ACES', 'ACES'],                    // all caps: unchanged
    ['AB', 'AB'],
    ['ACES22', 'ACES22'],
    ['aces', 'aces'],                    // all lowercase: unchanged
    ['johnSmith', 'john S.'],            // fix round 4: lowercase -> Uppercase is a word boundary too
    ['Zed', 'Zed'],                      // one capitalised word: unchanged
    ['Zed99', 'Zed99'],
    ['Jean-Luc', 'Jean-Luc'],            // two capitalised parts joined by ONE hyphen, nothing else: as typed
    ["O'Brien", "O'Brien"],              // O + apostrophe joins the next segment: one word
    ['Mary22Jones', 'Mary J.'],          // fix round 4: digits are a boundary
    ['AcesUp_77', 'Aces U.'],            // fix round 4: two joined words + '_' + digits
    ['A.J.', 'A.J.'],                    // existing '.' handling (initials): unchanged
    ['john.smith', 'john S.'],           // existing '.' handling: unchanged
    ['Mary_Jones', 'Mary J.'],           // existing '_' handling: unchanged
    ['josh.hall2', 'josh H.'],
    ['John Smith', 'John S.'],           // spaces: the existing First L. logic, unchanged
    ['Mary Ann Lee', 'Mary L.'],
  ])('%j stays on its current rule → %j', (raw, out) => {
    expect(broadcastNameOf(raw, false)).toBe(out);
  });

  it('the opt-out still wins, and an unknown opt-out still fails closed', () => {
    for (const raw of ['JohnSmith', 'JSmith', 'MaryJones22', 'AcesUp']) {
      expect(broadcastNameOf(raw, true)).toBe('Player');
      expect(broadcastNameOf(raw, undefined)).toBe('Player');
      expect(broadcastNameOf(raw, null)).toBe('Player');
    }
  });

  it('a phone-like / non-whitelist / over-20 one-word name is still "Player" before this rule runs', () => {
    expect(broadcastNameOf('JohnSmith5551234567', false)).toBe('Player');
    expect(broadcastNameOf('JohnSmithJohnSmithJohn', false)).toBe('Player');
    expect(broadcastNameOf('JohnSmith!', false)).toBe('Player');
  });
});

/**
 * Fix round 4 (2026-11-02) — the approved promise (rules line 1): the broadcast shows
 * "your public name (first name and last initial)", so NO surname may reach air.
 * The name is cut into word segments at spaces, '.', '_', '-', apostrophes, digits and
 * CamelCase boundaries (lowercase -> Uppercase; a run of one or two capitals before a
 * Capital+lowercase: 'TJMiller' -> TJ | Miller); never inside an all-caps or all-lowercase
 * run. A surname prefix (Mc, Mac, De, Di, Da, Du, Le, La, Van, Von, St) joins the next
 * capitalised segment, and so does a single capital before an apostrophe (O'Brien,
 * D'Angelo). A possessive "'s" is dropped. Two or more letter segments ->
 * "<first segment> <initial of the last segment>." (1-letter / digit junk is skipped when
 * choosing the last one; a 1-letter first segment is an initial: "J."); one letter
 * segment -> as typed.
 */
describe('broadcastNameOf — fix round 4: segments, so no surname reaches air', () => {
  it.each([
    // the leaks the checker found
    ['JohnSmith Jr', 'John J.'],
    ['JohnSmith_77', 'John S.'],
    ['JohnSmith.', 'John S.'],
    ['Mary22Jones', 'Mary J.'],
    ['Mary-JaneWatson', 'Mary W.'],
    ['JohnSmith-Lee', 'John L.'],
    ["JohnSmith's", 'John S.'],          // possessive 's dropped
    ['JohnSmith.Jones', 'John J.'],
    ['JohnSmith 2', 'John S.'],          // a pure-digit segment is never the last name
    ['JohnSmith22 x', 'John S.'],        // a 1-letter junk segment is never the last name
    // the garbled / odd ones
    ['JOHNsmith', 'JOHNsmith'],          // no boundary (all-caps run into all-lowercase): as typed
    ['JoHn', 'JoHn'],                    // <= 4 letters of alternating case: one word, as typed
    ['McDonald', 'McDonald'],            // surname prefix joins the next segment: one word
    ['LeBron', 'LeBron'],
    ['DeShawn', 'DeShawn'],
    // the owner's literal joined-words rule and plain aliases
    ['AcesUp', 'Aces U.'],
    ['AcesUp77', 'Aces U.'],
    ['ACES', 'ACES'],
    ['aces', 'aces'],
    // the hyphenated first name: two capitalised parts joined by one hyphen and NOTHING else
    // stay as typed (a 'Jean-Luc' cannot be told from a 'John-Smith'; documented choice)
    ['Jean-Luc', 'Jean-Luc'],
    ['Jean-Luc Picard', 'Jean P.'],      // any other segment: the usual rule
    ['Jean-Luc7', 'Jean L.'],
    // the existing spaced-name rule, unchanged
    ['John Smith', 'John S.'],
    ['Mary Ann Smith', 'Mary S.'],
    ["Dan O'Brien", 'Dan O.'],
    // prefixes / elisions inside longer names
    ['JohnMcDonald', 'John M.'],
    ["O'BrienSmith", "O'Brien S."],
    ['McDonaldSmith', 'McDonald S.'],
    // initials
    ['JSmith', 'J. S.'],
    ['J Smith', 'J. S.'],
    ['j.smith', 'j. S.'],
    ['A.J. Smith', 'A.J. S.'],
    ['A.J.', 'A.J.'],
    ['TJMiller', 'TJ M.'],
    // 20+ more realistic handles
    ['MikeJones', 'Mike J.'],
    ['SarahConnor99', 'Sarah C.'],
    ['BigSlick', 'Big S.'],
    ['PocketRockets', 'Pocket R.'],
    ['chris_evans', 'chris E.'],
    ['DJKhaled', 'DJ K.'],
    ['AJStyles', 'AJ S.'],
    ['MaryMcDonald', 'Mary M.'],
    ["SeanO'Malley", 'Sean O.'],
    ['LaToyaJackson', 'LaToya J.'],
    ['DeAndreHopkins', 'DeAndre H.'],
    ['KevinVanDyke', 'Kevin V.'],
    ['J.R. Smith', 'J.R. S.'],
    ['tony.stark3000', 'tony S.'],
    ['RIVERRAT', 'RIVERRAT'],
    ['river_rat', 'river R.'],
    ['Mary Jo Smith', 'Mary S.'],
    ["D'Angelo Russell", "D'Angelo R."],
    ["D'Angelo", "D'Angelo"],
    ['JoeSmith-Jones', 'Joe J.'],
    ['LeeSung22', 'Lee S.'],
    ['Ricky B', 'Ricky B.'],
    ['BobbyD.', 'Bobby D.'],
    ['MacKenzieLee', 'MacKenzie L.'],
    ['Lucky7Larry', 'Lucky L.'],
    ['lucky7', 'lucky7'],
    ['JJ', 'JJ'],
    ['JOHN_SMITH', 'JOHN S.'],
    ['johnSMITH', 'john S.'],
    ['2 JohnSmith', 'John S.'],
    ["Mary's", "Mary's"],                // possessive dropped -> one word -> as typed
  ])('%j → %j', (raw, out) => {
    expect(broadcastNameOf(raw, false)).toBe(out);
  });

  it('documented limits: no detectable boundary (or a prefix-word first name) stays as typed', () => {
    // No case change, separator or digit between the words: nothing to cut on.
    expect(broadcastNameOf('johnsmith', false)).toBe('johnsmith');
    expect(broadcastNameOf('JOHNSMITH', false)).toBe('JOHNSMITH');
    expect(broadcastNameOf('Johnsmith', false)).toBe('Johnsmith');
    // A 3+ capital run straight into lowercase is ambiguous (JOHN|smith or JOH|Nsmith): one word.
    expect(broadcastNameOf('JOHNsmith', false)).toBe('JOHNsmith');
    expect(broadcastNameOf('JOHNSmith', false)).toBe('JOHNSmith');
    // The 'Jean-Luc' choice: Capitalised-Capitalised with one hyphen and nothing else.
    expect(broadcastNameOf('John-Smith', false)).toBe('John-Smith');
    // A first name that is also a surname prefix joins the surname ('McDonald' rule).
    expect(broadcastNameOf('VonMiller', false)).toBe('VonMiller');
  });

  it('every output passes the display-name whitelist (or is "Player")', () => {
    const raws = ['JohnSmith Jr', "JohnSmith's", "O'BrienSmith", 'A.J. Smith', 'J Smith', 'x.y z', 'Jean-Luc', "D'Angelo Russell", '_JohnSmith_', 'JohnSmith22 x'];
    for (const raw of raws) {
      const out = broadcastNameOf(raw, false);
      expect(out === 'Player' || /^[A-Za-z0-9 _.'-]{1,20}$/.test(out)).toBe(true);
    }
  });

  it('opt-out / unknown still wins; phone-like / non-whitelist / over-20 still "Player"', () => {
    for (const raw of ['JohnSmith Jr', 'Mary22Jones', 'McDonald', 'Jean-Luc']) {
      expect(broadcastNameOf(raw, true)).toBe('Player');
      expect(broadcastNameOf(raw, undefined)).toBe('Player');
      expect(broadcastNameOf(raw, null)).toBe('Player');
    }
    expect(broadcastNameOf('JohnSmith 5551234', false)).toBe('Player');
    expect(broadcastNameOf('JohnSmithéJones', false)).toBe('Player');
    expect(broadcastNameOf('JohnnySmithersonJonesX', false)).toBe('Player');
  });
});

/**
 * The guarantee, as a property: a First + Last pair embedded in every separator / digit /
 * case shape that has a detectable boundary never puts the full Last name on air.
 * Excluded (the documented limits above): joined same-case words ('johnsmith',
 * 'JOHNSMITH', 'Johnsmith'), an all-caps first name run straight into the surname
 * ('JOHNSmith', 'JOHNsmith'), the bare 'Jean-Luc' shape ('John-Smith'), and a first
 * name that is a surname prefix (none in the list below).
 */
describe('broadcastNameOf — property: the full Last name never reaches air', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const FIRSTS = ['John', 'Mary', 'Josh', 'Ann', 'Kim', 'Al', 'Bo', 'Ed', 'Jo', 'Sam', 'Lily', 'Omar', 'Chen', 'Raj', 'Ava',
    'Eli', 'Zoe', 'Ivan', 'Nina', 'Paul', 'Luis', 'Tara', 'Ben', 'Amy', 'Dean', 'Stan', 'Rosa', 'Hugo', 'Kai', 'Ty', 'Max',
    'Lena', 'Owen', 'Ruby', 'Noah', 'Emma', 'Liam', 'Mia', 'Jack', 'Ella', 'DeShawn', 'LaToya', 'McKenzie', 'Tomas',
    'Grace', 'Henry', 'Isla', 'Felix', 'Nora', 'Theo'];
  const LASTS = ['Smith', 'Jones', 'Lee', 'Park', 'Hall', 'Brown', 'Garcia', 'Nguyen', 'Patel', 'Kim', 'Wong', 'Diaz', 'Cruz',
    'Ross', 'Reed', 'Fox', 'Ito', 'Day', 'Cole', 'Ford', 'Hart', 'Lowe', 'Moss', 'Nash', 'Pope', 'Rice', 'Shaw', 'Webb',
    'Young', 'Zhang', 'Miller', 'Watson', 'Turner', 'McDonald', 'MacKenzie', 'DeLuca', 'VanDyke', 'LeBlanc', "O'Brien",
    "D'Souza", 'StClair', 'DiMaggio', 'DuPont', 'LaRue', 'VonTrapp', 'Olsen', 'Ochoa', 'Castillo', 'Romero', 'Kowalski'];
  const T = (x: string) => x;
  const L = (x: string) => x.toLowerCase();
  const U = (x: string) => x.toUpperCase();
  const CASES = [T, L, U];
  const SEPS = [' ', '.', '_', '-', "'", '7', '22', '. ', '_-', '  '];
  const PREFIXES = ['', '2 ', '_', 'x '];
  const SUFFIXES = ['', '7', '22', '_77', '.', "'s", ' 2', ' x', ' Jr', '_'];

  it('500 First + Last pairs x every shape (bare + a random prefix / suffix): never the full Last name', () => {
    const r = rng(20261102);
    const pick = <X,>(a: X[]): X => a[Math.floor(r() * a.length)];
    const bad: Array<{ raw: string; out: string }> = [];
    let total = 0;
    let onAir = 0;
    let pairs = 0;
    while (pairs < 500) {
      const f = pick(FIRSTS);
      const l = pick(LASTS);
      if (f.toLowerCase().includes(l.toLowerCase())) continue;
      pairs++;
      const shapes: string[] = [];
      // Joined: only the shapes with a CamelCase boundary between the two words.
      shapes.push(f + l, L(f) + l, f + U(l), L(f) + U(l));
      for (const sep of SEPS) {
        for (const cf of CASES) {
          for (const cl of CASES) {
            if (sep === '-' && cf === T && cl === T && /^[A-Z][a-z]+$/.test(f) && /^[A-Z][a-z]+$/.test(l)) continue;   // the bare 'Jean-Luc' shape
            shapes.push(cf(f) + sep + cl(l));
          }
        }
      }
      for (const shape of shapes) {
        for (const raw of [shape, pick(PREFIXES) + shape + pick(SUFFIXES)]) {
          total++;
          const out = broadcastNameOf(raw, false);
          if (out === 'Player') continue;
          onAir++;
          const o = out.toLowerCase();
          const leak = o.includes(l.toLowerCase()) || o.includes(l.toLowerCase().replace(/'/g, ''));
          if (leak || !/^[A-Za-z0-9 _.'-]+ [A-Z]\.$/.test(out)) bad.push({ raw, out });
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(total).toBeGreaterThan(500 * 100);
    expect(onAir).toBeGreaterThan(total * 0.5);      // most shapes fit in 20 characters: the test is not vacuous
  });
});

describe('broadcastPid — opaque, stable within a process, per event', () => {
  it('"b-" + 16 hex; the same input → the same pid; another event → another pid; never contains the player id', () => {
    const a = broadcastPid('T1', 'user-42');
    expect(a).toMatch(/^b-[0-9a-f]{16}$/);
    expect(broadcastPid('T1', 'user-42')).toBe(a);
    expect(broadcastPid('T2', 'user-42')).not.toBe(a);
    expect(broadcastPid('T1', 'user-43')).not.toBe(a);
    // 2026-11-25 — was not.toContain('42'): the pid is 16 hex of a per-process
    // random salt's hash, so "42" appears by chance in ~6% of runs (failed
    // locally as "b-46e6f2420a1cfa6f"). The player id itself is what must never show.
    expect(a).not.toContain('user-42');
    expect(a).not.toContain('user');
  });
});

describe('optOutFromStats — users.stats as TEXT or an object', () => {
  it('true only for broadcastOptOut === true', () => {
    expect(optOutFromStats('{"broadcastOptOut":true}')).toBe(true);
    expect(optOutFromStats({ broadcastOptOut: true })).toBe(true);
    expect(optOutFromStats('{"broadcastOptOut":"true"}')).toBe(false);
    expect(optOutFromStats('{}')).toBe(false);
    expect(optOutFromStats('not json')).toBe(false);
    expect(optOutFromStats(null)).toBe(false);
  });
});

describe('the opt-out cache: a miss is unknown, queued, loaded in ONE batch, never blocking', () => {
  function store(rows: Array<{ id: number; masterUserId: string | null; optOut: boolean }>, opts: { fail?: boolean } = {}) {
    const calls: Array<{ userIds: number[]; masterIds: string[] }> = [];
    const scheduled: Array<() => void> = [];
    let t = 1_000_000;
    const s = createBroadcastOptOutStore({
      load: async (q) => {
        calls.push(q);
        if (opts.fail) throw new Error('db down');
        return rows.filter((r) => q.userIds.includes(r.id) || (r.masterUserId !== null && q.masterIds.includes(r.masterUserId)));
      },
      now: () => t,
      schedule: (fn) => { scheduled.push(fn); },
      log: () => {},
    });
    return { s, calls, scheduled, advance: (ms: number) => { t += ms; } };
  }

  it('a miss answers undefined (→ "Player") and queues by LOCAL id when there is one (a primary-key read), by master id only without one', async () => {
    const x = store([{ id: 7, masterUserId: 'm-7', optOut: true }, { id: 8, masterUserId: 'm-8', optOut: false }, { id: 9, masterUserId: 'm-9', optOut: false }]);
    expect(x.s.get({ userId: 7, masterUserId: 'm-7' })).toBeUndefined();
    expect(x.s.get({ userId: 8 })).toBeUndefined();
    expect(x.s.get({ masterUserId: 'm-9' })).toBeUndefined();
    expect(x.scheduled).toHaveLength(1);                    // one batch scheduled for the three misses
    await x.s.flush();
    expect(x.calls).toEqual([{ userIds: [7, 8], masterIds: ['m-9'] }]);
    expect(x.s.get({ userId: 7 })).toBe(true);
    expect(x.s.get({ masterUserId: 'm-7' })).toBe(true);     // the row named its master id: both keys known
    expect(x.s.get({ userId: 8, masterUserId: 'm-8' })).toBe(false);
    expect(x.s.get({ masterUserId: 'm-9' })).toBe(false);
  });

  it('a DB error keeps them unknown ("Player") and is not re-read for 30 s; no ids at all → unknown, nothing queued', async () => {
    const x = store([], { fail: true });
    expect(x.s.get({ userId: 5 })).toBeUndefined();
    await x.s.flush();
    expect(x.s.stats().loadErrors).toBe(1);
    expect(x.s.get({ userId: 5 })).toBeUndefined();
    x.advance(3000);
    await x.s.flush();
    expect(x.calls).toHaveLength(1);                         // inside the 30 s retry window: not queued again
    x.advance(31_000);
    expect(x.s.get({ userId: 5 })).toBeUndefined();
    await x.s.flush();
    expect(x.calls).toHaveLength(2);
    const before = x.scheduled.length;
    expect(x.s.get({})).toBeUndefined();
    expect(x.scheduled.length).toBe(before);
  });

  it('set() records both keys; two answers that disagree read as opted out (fail-closed)', () => {
    const x = store([]);
    x.s.set({ userId: 1, masterUserId: 'm-1' }, false);
    expect(x.s.get({ userId: 1 })).toBe(false);
    expect(x.s.get({ masterUserId: 'm-1' })).toBe(false);
    x.s.set({ userId: 2 }, false);
    x.s.set({ masterUserId: 'm-2' }, true);
    expect(x.s.get({ userId: 2, masterUserId: 'm-2' })).toBe(true);
  });
});
