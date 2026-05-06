const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf8');

const replacements = [
  ['const result = getUserFromToken(', 'const result = await getUserFromToken('],
  ['const result = registerUser(', 'const result = await registerUser('],
  ['const taken = isUsernameTaken(', 'const taken = await isUsernameTaken('],
  ['const result = loadProgress(', 'const result = await loadProgress('],
  ['const success = saveProgress(', 'const success = await saveProgress('],
  ['chipsAtStart: getUserChips(', 'chipsAtStart: await getUserChips('],
  ['const currentChips = getUserChips(', 'const currentChips = await getUserChips('],
  ['const dbChips = getUserChips(', 'const dbChips = await getUserChips('],
  ['addChipsToUser(auth.userId, chips)', 'await addChipsToUser(auth.userId, chips)'],
  ['const success = addChipsToUser(', 'const success = await addChipsToUser('],
  ['!isUserAdmin(auth.userId)', '!(await isUserAdmin(auth.userId))'],
  ['isUserBanned(authForJoin.userId)', 'await isUserBanned(authForJoin.userId)'],
  ['totalUsers: getTotalUsers()', 'totalUsers: await getTotalUsers()'],
  ['users: getAllUsers()', 'users: await getAllUsers()'],
  ['const entries = getLeaderboard(', 'const entries = await getLeaderboard('],
  ['results: searchUsers(', 'results: await searchUsers('],
];

let changes = 0;
for (const [from, to] of replacements) {
  while (code.includes(from)) {
    code = code.replace(from, to);
    changes++;
  }
}

// mergeUserStats - multiple occurrences, use regex with lookbehind
code = code.replace(/([^a])(mergeUserStats\()/g, '$1await mergeUserStats(');

// saveProgress without 'const success ='
code = code.replace(/([^a])(saveProgress\(authSession)/g, '$1await saveProgress(authSession');

// deductChips
code = code.replace('if (!deductChips(', 'if (!(await deductChips(');

// initDB - make it async
code = code.replace('initDB();\ninitClubTables', 'initDB().then(() => { initClubTables');

// Make all socket.on handlers async
code = code.replace(/socket\.on\('([^']+)',\s*\(([^)]*)\)\s*=>\s*\{/g, function(match, event, params) {
  if (match.includes('async')) return match;
  return "socket.on('" + event + "', async (" + params + ") => {";
});
code = code.replace(/socket\.on\('([^']+)',\s*\(\)\s*=>\s*\{/g, function(match, event) {
  if (match.includes('async')) return match;
  return "socket.on('" + event + "', async () => {";
});

fs.writeFileSync('src/index.ts', code);
console.log('Applied', changes, 'explicit replacements + regex fixes');
