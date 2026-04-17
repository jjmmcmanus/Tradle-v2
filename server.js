require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const cron = require('node-cron');

// ─── Express setup ───────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'tradle-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 365 }
}));

// ─── Supabase ────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

// ─── Word logic ──────────────────────────────────────────────────
const WORDS = [
  "ALPHA","SIGMA","CALLS","SWAPS","RATIO","BLOCK","FILLS","CROSS","QUOTE","PRINT",
  "HEDGE","SHORT","RALLY","GRIND","SCALP","PIVOT","RANGE","SWING","SPIKE","BREAK",
  "SWEEP","FADED","WICKS","DUMPS","PUMPS","YIELD","BASIS","BONDS","NOTES","MACRO",
  "MICRO","LIMIT","PAPER","OFFER","PRICE","BUYER","MOVER","INDEX","ENTER","TRADE",
  "EDGED","PLACE","RISKY","LONGS","BROKE","DOUGH","MONEY","WEDGE","GOYIM","GOYUM",
  "LARPS","FAKED","GOONS","ZESTY","ROOKS","SAUCE","BANKS","FUNDS","PAIRS","ENTRY",
  "CHART","STOCK","SHARE","HIGHS","TREND","JOHNV","SLOPS","BASED","CLOUT","TINGS","MOGGS"
];

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

function getDailyWord(dateStr) {
  if (!dateStr) dateStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  return WORDS[hashStr(dateStr) % WORDS.length];
}

// ─── Routes ──────────────────────────────────────────────────────

// Root — serve game with client ID injected
app.get('/', (req, res) => {
  try {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    const clientId = process.env.DISCORD_CLIENT_ID || '';
    html = html.replace("window.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID'", `'${clientId}'`);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Failed to serve index.html:', e.message);
    res.status(500).send('Game failed to load: ' + e.message);
  }
});

// Discord OAuth callback
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || '',
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI || '',
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('No access token:', tokenData);
      return res.redirect('/');
    }
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    res.redirect('/');
  } catch (e) {
    console.error('OAuth error:', e.message);
    res.redirect('/');
  }
});

// Get current session user
app.get('/auth/me', (req, res) => {
  if (req.session.user) return res.json(req.session.user);
  res.status(401).json({ error: 'Not logged in' });
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Get score for today
app.get('/api/score', async (req, res) => {
  const { userId, date } = req.query;
  if (!userId || !date) return res.status(400).json({ error: 'Missing params' });
  try {
    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('user_id', userId)
      .eq('date', date)
      .single();
    if (error || !data) return res.json({ submitted: false });
    res.json({ submitted: true, tries: data.tries, won: data.won, word: data.word, guesses: data.guesses });
  } catch (e) {
    res.json({ submitted: false });
  }
});

// Submit score
app.post('/api/score', async (req, res) => {
  const { userId, username, tries, won, guesses, date } = req.body;
  if (!userId || !username) return res.status(400).json({ error: 'Missing params' });
  try {
    await supabase.from('scores').upsert({
      user_id: userId,
      username,
      tries,
      won,
      guesses,
      date,
      word: getDailyWord(date),
    }, { onConflict: 'user_id,date', ignoreDuplicates: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static files last
app.use(express.static(path.join(__dirname, 'public')));

// ─── Discord Bot ─────────────────────────────────────────────────
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('tradle').setDescription('Play Tradle — Trading & TnB Wordle').toJSON(),
  new SlashCommandBuilder().setName('tradle-leaderboard').setDescription("See today's Tradle leaderboard").toJSON(),
  new SlashCommandBuilder().setName('tradle-help').setDescription('How to play Tradle').toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN || '');
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID || ''), { body: commands });
    console.log('Slash commands registered');
  } catch (e) { console.error('Command register error:', e.message); }
}

async function getLeaderboardEmbed(dateStr) {
  if (!dateStr) dateStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  const word = getDailyWord(dateStr);
  try {
    const { data } = await supabase
      .from('scores').select('username,tries,won').eq('date', dateStr).order('tries', { ascending: true });
    if (!data || data.length === 0) {
      return { title: `Tradle Leaderboard — ${dateStr}`, description: 'No scores yet today!', color: 0x3B6D11 };
    }
    const medals = ['🥇', '🥈', '🥉'];
    let desc = `Today's word: **${word}**\n\n`;
    data.forEach((row, i) => {
      const medal = medals[i] || `${i + 1}.`;
      desc += `${medal} **${row.username}** — ${row.won ? `${row.tries}/6` : 'X/6'}\n`;
    });
    const solvers = data.filter(r => r.won).length;
    desc += `\n${solvers}/${data.length} solved today`;
    return { title: `🟩 Tradle Leaderboard — ${dateStr}`, description: desc, color: 0x3B6D11, footer: { text: 'Resets at midnight UK time' } };
  } catch (e) {
    return { title: 'Leaderboard error', description: e.message, color: 0x3B6D11 };
  }
}

discordClient.once('clientReady', async () => {
  console.log(`Tradle bot online as ${discordClient.user.tag}`);
  await registerCommands();
});

discordClient.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const gameUrl = process.env.GAME_URL || 'https://tradle-v2-production.up.railway.app';

  if (interaction.commandName === 'tradle') {
    await interaction.reply({
      embeds: [{ title: '🟩 Tradle — Trading & TnB Wordle', description: `Guess the 5-letter trading word in 6 tries.\n\n**[▶ Play now](${gameUrl})**`, color: 0x3B6D11, footer: { text: '🟩 correct  🟨 wrong spot  ⬛ not in word' } }]
    });
  }
  if (interaction.commandName === 'tradle-leaderboard') {
    await interaction.deferReply();
    const embed = await getLeaderboardEmbed();
    await interaction.editReply({ embeds: [embed] });
  }
  if (interaction.commandName === 'tradle-help') {
    await interaction.reply({
      ephemeral: true,
      embeds: [{ title: 'How to play Tradle', description: `Guess the **5-letter** word in **6 tries**.\n\n🟩 Right letter, right spot\n🟨 Right letter, wrong spot\n⬛ Not in the word\n\nLog in with Discord once — remembered forever after.\n\n**[Play here](${gameUrl})**`, color: 0x3B6D11 }]
    });
  }
});

// Auto post leaderboard at 23:58 UK time
cron.schedule('58 23 * * *', async () => {
  const channelId = process.env.LEADERBOARD_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await discordClient.channels.fetch(channelId);
    const embed = await getLeaderboardEmbed();
    embed.title = '🏆 Final Tradle Leaderboard — ' + new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
    embed.footer = { text: 'New word drops at midnight!' };
    await channel.send({ embeds: [embed] });
  } catch (e) { console.error('Leaderboard post error:', e.message); }
}, { timezone: 'Europe/London' });

// ─── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

if (process.env.DISCORD_TOKEN) {
  discordClient.login(process.env.DISCORD_TOKEN).catch(e => console.error('Discord login error:', e.message));
} else {
  console.error('No DISCORD_TOKEN set');
}
