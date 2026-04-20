require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'tradle-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 365 }
}));

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const WORDS = [
  "ALPHA","SIGMA","CALLS","SWAPS","RATIO","BLOCK","FILLS","CROSS","QUOTE","PRINT",
  "HEDGE","SHORT","RALLY","GRIND","SCALP","PIVOT","RANGE","SWING","SPIKE","BREAK",
  "SWEEP","FADED","WICKS","DUMPS","PUMPS","YIELD","BASIS","BONDS","NOTES","MACRO",
  "MICRO","LIMIT","PAPER","OFFER","PRICE","BUYER","MOVER","INDEX","ENTER","TRADE",
  "EDGED","PLACE","RISKY","LONGS","BROKE","DOUGH","MONEY","WEDGE","GOYIM","GOYUM",
  "LARPS","FAKED","GOONS","ZESTY","ROOKS","SAUCE","BANKS","FUNDS","PAIRS","ENTRY",
  "CHART","STOCK","SHARE","HIGHS","TREND","JOHNV","SLOPS","BASED","CLOUT","TINGS","MOGGS"
];

function hashStr(str) { let h=0; for(let i=0;i<str.length;i++){h=(Math.imul(31,h)+str.charCodeAt(i))|0;} return Math.abs(h); }
function getDailyWord(dateStr) { if(!dateStr) dateStr=new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'}); return WORDS[hashStr(dateStr)%WORDS.length]; }
function getUKDate() { return new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'}); }

app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8');
    html = html.replace("window.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID'", `'${process.env.DISCORD_CLIENT_ID||''}'`);
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch(e) { res.status(500).send('Error: '+e.message); }
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if(!code) return res.redirect('/');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:process.env.DISCORD_CLIENT_ID||'',
        client_secret:process.env.DISCORD_CLIENT_SECRET||'',
        grant_type:'authorization_code',
        code,
        redirect_uri:process.env.REDIRECT_URI||'',
      })
    });
    const tokenData = await tokenRes.json();
    if(!tokenData.access_token) return res.redirect('/');
    const userRes = await fetch('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${tokenData.access_token}`}});
    const user = await userRes.json();
    req.session.user = {id:user.id,username:user.username,avatar:user.avatar};
    res.redirect('/');
  } catch(e) { res.redirect('/'); }
});

app.get('/auth/me', (req, res) => {
  if(req.session.user) return res.json(req.session.user);
  res.status(401).json({error:'Not logged in'});
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.get('/api/score', async (req, res) => {
  const {userId, date} = req.query;
  if(!userId||!date) return res.status(400).json({error:'Missing params'});
  try {
    const {data} = await supabase.from('scores').select('*').eq('user_id',userId).eq('date',date).single();
    if(!data) return res.json({submitted:false});
    res.json({submitted:true,tries:data.tries,won:data.won,word:data.word,guesses:data.guesses});
  } catch(e) { res.json({submitted:false}); }
});

app.post('/api/score', async (req, res) => {
  const {userId, username, tries, won, guesses, date} = req.body;
  if(!userId||!username) return res.status(400).json({error:'Missing params'});
  try {
    const {data: existing} = await supabase.from('scores').select('user_id').eq('user_id',userId).eq('date',date).single();
    const isFirstSubmission = !existing;

    await supabase.from('scores').upsert({
      user_id:userId, username, tries, won, guesses, date, word:getDailyWord(date),
    },{onConflict:'user_id,date',ignoreDuplicates:true});

    if(isFirstSubmission && process.env.RESULTS_CHANNEL_ID) {
      postResultToDiscord(username, tries, won, guesses, date).catch(e=>console.error('Post result error:',e.message));
    }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

async function postResultToDiscord(username, tries, won, guesses, date) {
  const channelId = process.env.RESULTS_CHANNEL_ID;
  if(!channelId || !discordClient.isReady()) return;
  try {
    const channel = await discordClient.channels.fetch(channelId);
    const score = won ? `${tries}/6` : 'X/6';
    const emojiGrid = (guesses||[]).map(row => row.map(s => s==='g'?'🟩':s==='y'?'🟨':'⬛').join('')).join('\n');
    const msg = `**${username}** — Tradle ${date} — ${score}\n${emojiGrid}`;
    await channel.send(msg);
  } catch(e) { console.error('Discord post error:',e.message); }
}

app.get('/api/leaderboard', async (req, res) => {
  const date = req.query.date || getUKDate();
  try {
    const {data} = await supabase.from('scores')
      .select('username,tries,won,guesses')
      .eq('date',date)
      .order('tries',{ascending:true})
      .order('created_at',{ascending:true});
    res.json({date, scores: data || []});
  } catch(e) { res.json({date, scores:[]}); }
});

app.use(express.static(path.join(__dirname,'public')));

const discordClient = new Client({intents:[GatewayIntentBits.Guilds]});

const commands = [
  new SlashCommandBuilder().setName('tradle').setDescription('Play Tradle — Trading & TnB Wordle').toJSON(),
  new SlashCommandBuilder().setName('tradle-leaderboard').setDescription("See today's Tradle leaderboard").toJSON(),
  new SlashCommandBuilder().setName('tradle-help').setDescription('How to play Tradle').toJSON(),
];

async function registerCommands() {
  const rest = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN||'');
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID||''),{body:commands});
    console.log('Slash commands registered');
  } catch(e) { console.error('Command register error:',e.message); }
}

async function getLeaderboardEmbed(dateStr, showWord = false) {
  if(!dateStr) dateStr = getUKDate();
  try {
    const {data} = await supabase.from('scores')
      .select('username,tries,won')
      .eq('date',dateStr)
      .order('tries',{ascending:true})
      .order('created_at',{ascending:true});
    if(!data || data.length===0) {
      return {title:`Tradle Leaderboard — ${dateStr}`, description:'No scores yet today!', color:0x3B6D11};
    }
    const medals = ['🥇','🥈','🥉'];
    let desc = '';
    data.forEach((row,i) => {
      const medal = medals[i] || `${i+1}.`;
      desc += `${medal} **${row.username}** — ${row.won ? `${row.tries}/6` : 'X/6'}\n`;
    });
    const solvers = data.filter(r=>r.won).length;
    desc += `\n${solvers}/${data.length} solved today`;
    if(showWord) desc += `\n\nWord was: **${getDailyWord(dateStr)}**`;
    return {
      title: `🟩 Tradle Leaderboard — ${dateStr}`,
      description: desc,
      color: 0x3B6D11,
      footer:{text: showWord ? 'New word drops at midnight!' : 'Resets at midnight UK time'}
    };
  } catch(e) {
    return {title:'Leaderboard error', description:e.message, color:0x3B6D11};
  }
}

discordClient.once('clientReady', async () => {
  console.log(`Tradle bot online as ${discordClient.user.tag}`);
  await registerCommands();
  startMidnightScheduler();
});

discordClient.on('interactionCreate', async (interaction) => {
  if(!interaction.isChatInputCommand()) return;
  const gameUrl = process.env.GAME_URL || 'https://tradle-v2-production.up.railway.app';

  if(interaction.commandName === 'tradle') {
    await interaction.reply({embeds:[{
      title:'🟩 Tradle — Trading & TnB Wordle',
      description:`Guess the 5-letter trading word in 6 tries.\n\n**[▶ Play now](${gameUrl})**`,
      color:0x3B6D11,
      footer:{text:'🟩 correct  🟨 wrong spot  ⬛ not in word'}
    }]});
  }
  if(interaction.commandName === 'tradle-leaderboard') {
    await interaction.deferReply();
    const embed = await getLeaderboardEmbed(getUKDate(), false);
    await interaction.editReply({embeds:[embed]});
  }
  if(interaction.commandName === 'tradle-help') {
    await interaction.reply({
      ephemeral:true,
      embeds:[{
        title:'How to play Tradle',
        description:`Guess the **5-letter** word in **6 tries**.\n\n🟩 Right letter, right spot\n🟨 Right letter, wrong spot\n⬛ Not in the word\n\n**[Play here](${gameUrl})**`,
        color:0x3B6D11
      }]
    });
  }
});

function startMidnightScheduler() {
  let lastFired = '';
  setInterval(async () => {
    const now = new Date();
    const ukTime = new Date(now.toLocaleString('en-US',{timeZone:'Europe/London'}));
    const hour = ukTime.getHours();
    const min = ukTime.getMinutes();
    const todayKey = ukTime.toDateString();

    if(hour === 23 && min === 59 && lastFired !== todayKey) {
      lastFired = todayKey;
      const channelId = process.env.LEADERBOARD_CHANNEL_ID;
      if(!channelId) { console.log('No LEADERBOARD_CHANNEL_ID set'); return; }
      try {
        const channel = await discordClient.channels.fetch(channelId);
        const dateStr = getUKDate();
        const embed = await getLeaderboardEmbed(dateStr, true);
        embed.title = `🏆 Final Tradle Leaderboard — ${dateStr}`;
        await channel.send({embeds:[embed]});
        console.log('Leaderboard auto-posted');
      } catch(e) { console.error('Leaderboard post error:',e.message); }
    }
  }, 30000);
  console.log('Midnight scheduler started');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

if(process.env.DISCORD_TOKEN) {
  discordClient.login(process.env.DISCORD_TOKEN).catch(e => console.error('Discord login error:',e.message));
} else { console.error('No DISCORD_TOKEN set'); }
