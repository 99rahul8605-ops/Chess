require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
let BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Telegram Mini App ke liye HTTPS zaruri hai
if (BASE_URL.startsWith('http://') && !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1')) {
  BASE_URL = BASE_URL.replace('http://', 'https://');
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game storage
const games = new Map();

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
}

// ========== API ROUTES (Game Logic) ==========
app.post('/api/game/new', (req, res) => {
  const gameId = uuidv4().slice(0, 8);
  const chess = new Chess();
  games.set(gameId, {
    chess,
    whiteUserId: null,
    blackUserId: null,
    clients: new Map(),
    createdAt: Date.now()
  });
  res.json({ gameId, url: getGameUrl(gameId) });
});

app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let assignedColor = game.clients.get(userId);
  if (!assignedColor) {
    if (!game.whiteUserId) {
      assignedColor = 'white';
      game.whiteUserId = userId;
    } else if (!game.blackUserId) {
      assignedColor = 'black';
      game.blackUserId = userId;
    } else {
      return res.status(403).json({ error: 'Game is full' });
    }
    game.clients.set(userId, assignedColor);
  }
  res.json({ color: assignedColor, fen: game.chess.fen() });
});

// Clean up old games (1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    if (now - game.createdAt > 3600000) games.delete(id);
  }
}, 600000);

// ========== TELEGRAM BOT LOGIC ==========
const bot = new Telegraf(BOT_TOKEN);

async function createGame(ctx) {
  try {
    // API se naya game link mangwana
    const response = await fetch(`${BASE_URL}/api/game/new`, { method: 'POST' });
    const data = await response.json();
    const gameUrl = data.url;

    const messageText = `🎮 *New Chess Game Created!*\n\nNiche diye gaye button par click karke Join karein.`;

    // FIXED: Group ke liye 'url' button use kiya hai, 'web_app' nahi
    // Isse BUTTON_TYPE_INVALID error nahi aayega
    const replyMarkup = {
      inline_keyboard: [
        [
          { 
            text: '♟️ Play Chess (Join)', 
            url: gameUrl 
          }
        ]
      ]
    };
    
    await ctx.reply(messageText, { 
      parse_mode: 'Markdown', 
      reply_markup: replyMarkup 
    });

  } catch (err) {
    console.error('Error:', err);
    ctx.reply('⚠️ Error: Server link (BASE_URL) sahi nahi hai ya server down hai.');
  }
}

// Commands
bot.command('newgame', (ctx) => createGame(ctx));
bot.start((ctx) => ctx.reply('Chess bot ready! /newgame likhein.'));

// Server aur Bot ko start karna
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  bot.launch()
    .then(() => console.log('✅ Bot is online!'))
    .catch((err) => console.error('❌ Bot error:', err));
});

// Safe shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
