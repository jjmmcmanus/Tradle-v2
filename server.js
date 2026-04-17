require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'tradle-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 365 } // 1 year
}));

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Discord OAuth ───────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if(!code) return res.redirect('/');

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
      })
    });
    const tokenData = await tokenRes.json();

    // Get user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();

    // Save to session
    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar
    };

    res.redirect('/');
  } catch(e) {
    console.error('OAuth error:', e);
    res.redirect('/');
  }
});

app.get('/auth/me', (req, res) => {
  if(req.session.user) return res.json(req.session.user);
  res.status(401).json({ error: 'Not logged in' });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Inject Discord client ID into page
app.get('/', (req, res) => {
  let html = require('fs').readFileSync(path.join(__dirname,'public','index.html'),'utf8');
  html = html.replace("window.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID'", `'${process.env.DISCORD_CLIENT_ID}'`);
  res.send(html);
});

// ─── Score API ───────────────────────────────────────────────────
app.get('/api/score', async (req, res) => {
  const { userId, date } = req.query;
  if(!userId || !date) return res.status(400).json({ error: 'Missing params' });

  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .eq('user_id', userId)
    .eq('date', date)
    .single();

  if(error || !data) return res.json({ submitted: false });
  res.json({ submitted: true, tries: data.tries, won: data.won, word: data.word, guesses: data.guesses });
});

app.post('/api/score', async (req, res) => {
  const { userId, username, tries, won, guesses, date } = req.body;
  if(!userId || !username) return res.status(400).json({ error: 'Missing params' });

  // Upsert — only save first attempt
  const { error } = await supabase
    .from('scores')
    .upsert({
      user_id: userId,
      username,
      tries,
      won,
      guesses,
      date,
      word: getDailyWord(date),
    }, { onConflict: 'user_id,date', ignoreDuplicates: true });

  if(error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── Daily word logic ────────────────────────────────────────────
const WORDS = [
  "ALPHA","SIGMA","CALLS","SWAPS","RATIO","BLOCK","FILLS","CROSS","QUOTE","PRINT",
  "HEDGE","SHORT","RALLY","GRIND","SCALP","PIVOT","RANGE","SWING","SPIKE","BREAK",
  "SWEEP","FADED","WICKS","DUMPS","PUMPS","YIELD","BASIS","BONDS","NOTES","MACRO",
  "MICRO","LIMIT","PAPER","OFFER","PRICE","BUYER","MOVER","INDEX","ENTER","TRADE",
  "EDGED","PLACE","RISKY","LONGS","BROKE","DOUGH","MONEY","WEDGE","GOYIM","GOYUM",
  "LARPS","FAKED","GOONS","ZESTY","ROOKS","SAUCE","BANKS","FUNDS","PAIRS","ENTRY",
  "CHART","STOCK","SHARE","HIGHS","TREND","JOHNV","SLOPS","BASED","CLOUT","TINGS","MOGGS"
];

function hashStr(str){
  let h=0;for(let i=0;i<str.length;i++){h=(Math.imul(31,h)+str.charCodeAt(i))|0;}return Math.abs(h);
}

function getDailyWord(dateStr){
  if(!dateStr){
    dateStr = new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'});
  }
  return WORDS[hashStr(dateStr)%WORDS.length];
}

// ─── Discord Bot + Leaderboard ───────────────────────────────────
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('tradle').setDescription('Play Tradle — Trading & TnB Wordle').toJSON(),
  new SlashCommandBuilder().setName('tradle-leaderboard').setDescription('See today\'s Tradle leaderboard').toJSON(),
  new SlashCommandBuilder().setName('tradle-help').setDescription('How to play Tradle').toJSON(),
];

async function registerCommands(){
  const rest = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('Slash commands registered');
  } catch(e){ console.error('Command register error:', e); }
}

async function getLeaderboardEmbed(date){
  const dateStr = date || new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'});
  const word = getDailyWord(dateStr);

  const { data, error } = await supabase
    .from('scores')
    .select('username,tries,won')
    .eq('date', dateStr)
    .order('tries', { ascending: true });

  if(error || !data || data.length === 0){
    return {
      title: `Tradle Leaderboard — ${dateStr}`,
      description: 'No scores yet today! Be the first to play.',
      color: 0x3B6D11,
    };
  }

  const medals = ['🥇','🥈','🥉'];
  const triesLabel = (t) => t === 7 ? 'X/6' : `${t}/6`;

  let desc = `Today's word: **${word}**\n\n`;
  data.forEach((row, i) => {
    const medal = medals[i] || `${i+1}.`;
    const won = row.won ? triesLabel(row.tries) : 'X/6';
    desc += `${medal} **${row.username}** — ${won}\n`;
  });

  const solvers = data.filter(r=>r.won).length;
  desc += `\n${solvers}/${data.length} solved today`;

  return {
    title: `🟩 Tradle Leaderboard — ${dateStr}`,
    description: desc,
    color: 0x3B6D11,
    footer: { text: 'Resets at midnight UK time' }
  };
}

discordClient.once('ready', async () => {
  console.log(`Tradle bot online as ${discordClient.user.tag}`);
  await registerCommands();
});

discordClient.on('interactionCreate', async (interaction) => {
  if(!interaction.isChatInputCommand()) return;

  if(interaction.commandName === 'tradle'){
    await interaction.reply({
      embeds:[{
        title: '🟩 Tradle — Trading & TnB Wordle',
        description: `Guess the 5-letter trading word in 6 tries.\n\n**[▶ Play now](${process.env.GAME_URL})**`,
        color: 0x3B6D11,
        footer: { text: '🟩 correct spot  🟨 wrong spot  ⬛ not in word' }
      }]
    });
  }

  if(interaction.commandName === 'tradle-leaderboard'){
    await interaction.deferReply();
    const embed = await getLeaderboardEmbed();
    await interaction.editReply({ embeds: [embed] });
  }

  if(interaction.commandName === 'tradle-help'){
    await interaction.reply({
      ephemeral: true,
      embeds:[{
        title: 'How to play Tradle',
        description: [
          'Guess the **5-letter** trading or TnB word in **6 tries**.',
          '',
          '🟩 **Green** — right letter, right spot',
          '🟨 **Yellow** — right letter, wrong spot',
          '⬛ **Grey** — letter not in the word',
          '',
          'Log in with Discord once — we remember you every day after that.',
          '',
          `**[Play here](${process.env.GAME_URL})**`,
        ].join('\n'),
        color: 0x3B6D11,
      }]
    });
  }
});

// ─── Daily midnight leaderboard post ─────────────────────────────
// Runs at 23:58 UK time every day — posts final leaderboard to channel
cron.schedule('58 23 * * *', async () => {
  const channelId = process.env.LEADERBOARD_CHANNEL_ID;
  if(!channelId){ console.log('No LEADERBOARD_CHANNEL_ID set'); return; }

  try {
    const channel = await discordClient.channels.fetch(channelId);
    const embed = await getLeaderboardEmbed();
    embed.title = '🏆 Final Tradle Leaderboard — ' + new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'});
    embed.footer = { text: 'New word drops at midnight UK time!' };
    await channel.send({ embeds: [embed] });
    console.log('Leaderboard posted');
  } catch(e){ console.error('Leaderboard post error:', e); }
}, { timezone: 'Europe/London' });

// Start server and bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
discordClient.login(process.env.DISCORD_TOKEN);
