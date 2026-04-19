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

BASE_URL = BASE_URL.replace(/\/$/, '');
if (BASE_URL.startsWith('http://') && !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1')) {
  BASE_URL = BASE_URL.replace('http://', 'https://');
}

console.log(`🌐 BASE_URL: ${BASE_URL}`);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== AUTO-FETCH BOT INFO ==========
// Fetches both username and the Mini App short name from BotFather
let BOT_USERNAME = null;
let MINI_APP_NAME = null; // The short name you set in BotFather → Bot Menu / Web App

async function fetchBotInfo() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok) {
      BOT_USERNAME = data.result.username;
      console.log(`✅ Bot username: @${BOT_USERNAME}`);
    } else {
      console.error('❌ getMe failed:', data.description);
    }
  } catch (err) {
    console.error('❌ Could not fetch bot info:', err.message);
  }
}

// ========== GAME STORAGE ==========
const games = new Map();

function createNewGame() {
  const gameId = uuidv4().slice(0, 8);
  games.set(gameId, {
    chess: new Chess(),
    whiteUserId: null,
    blackUserId: null,
    players: new Map(),
    createdAt: Date.now()
  });
  return gameId;
}

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
}

// ========================================
// MINI APP DIRECT LINK
// Format: https://t.me/BotUsername/AppShortName?startapp=PAYLOAD
//
// How to set this up in BotFather:
//   1. /newapp  (or /myapps → your bot → Edit → Web App)
//   2. Set the Web App URL to your BASE_URL
//   3. Give it a short name e.g. "game"
//   4. Then your link becomes: https://t.me/YourBot/game?startapp=GAMEID
//
// The Mini App receives the gameId via:
//   Telegram.WebApp.initDataUnsafe.start_param
// ========================================
function getMiniAppLink(gameId) {
  const appName = process.env.MINI_APP_SHORT_NAME || 'game'; // set in .env
  return `https://t.me/${BOT_USERNAME}/${appName}?startapp=${gameId}`;
}

// ========== API ROUTES ==========

app.post('/api/game/new', (req, res) => {
  const gameId = createNewGame();
  res.json({ gameId, url: getGameUrl(gameId), miniAppLink: BOT_USERNAME ? getMiniAppLink(gameId) : null });
});

app.get('/api/game/:gameId', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({
    fen: game.chess.fen(),
    turn: game.chess.turn(),
    isGameOver: game.chess.isGameOver(),
    whiteReady: !!game.whiteUserId,
    blackReady: !!game.blackUserId
  });
});

app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  if (game.players.has(userId)) {
    return res.json({ color: game.players.get(userId), fen: game.chess.fen() });
  }

  let assignedColor;
  if (!game.whiteUserId) {
    assignedColor = 'white';
    game.whiteUserId = userId;
  } else if (!game.blackUserId) {
    assignedColor = 'black';
    game.blackUserId = userId;
  } else {
    return res.json({ color: 'spectator', fen: game.chess.fen() });
  }

  game.players.set(userId, assignedColor);
  res.json({ color: assignedColor, fen: game.chess.fen() });
});

app.post('/api/game/:gameId/move', (req, res) => {
  const { gameId } = req.params;
  const { userId, move } = req.body;
  if (!userId || !move) return res.status(400).json({ error: 'userId and move required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.players.get(userId);
  if (!playerColor || playerColor === 'spectator') return res.status(403).json({ error: 'Not a player' });

  const currentTurn = game.chess.turn();
  if ((currentTurn === 'w' && playerColor !== 'white') || (currentTurn === 'b' && playerColor !== 'black')) {
    return res.status(403).json({ error: 'Not your turn' });
  }

  if (!game.whiteUserId || !game.blackUserId) {
    return res.status(400).json({ error: 'Waiting for opponent' });
  }

  try {
    const result = game.chess.move(move);
    if (!result) return res.status(400).json({ error: 'Invalid move' });
    res.json({ success: true, move: result, fen: game.chess.fen(), isGameOver: game.chess.isGameOver() });
  } catch (err) {
    res.status(400).json({ error: 'Invalid move: ' + err.message });
  }
});

// Cleanup every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    if (now - game.createdAt > 3600000) games.delete(id);
  }
}, 600000);

// ========== TELEGRAM BOT ==========
const bot = new Telegraf(BOT_TOKEN);

// ==========================================
// INLINE MODE
// When user types "@YourBot" in any chat,
// bot returns an inline result with a
// Mini App button — works in groups too!
//
// To enable: BotFather → /setinline → set placeholder text
// ==========================================
bot.on('inline_query', async (ctx) => {
  const gameId = createNewGame();
  const miniAppLink = getMiniAppLink(gameId);
  const gameUrl = getGameUrl(gameId);

  await ctx.answerInlineQuery([
    {
      type: 'article',
      id: gameId,
      title: '♟️ Start a Chess Game',
      description: 'Send a chess game invite to this chat',
      input_message_content: {
        message_text: `🎮 *Chess Game Challenge!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black\n\nTap below to play!`,
        parse_mode: 'Markdown'
      },
      // ✅ This button works in groups via inline mode!
      reply_markup: {
        inline_keyboard: [[
          { text: '♟️ Play Chess', url: miniAppLink }
        ]]
      },
      thumbnail_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Chess_kdt45.svg/45px-Chess_kdt45.svg.png'
    }
  ], { cache_time: 0 });
});

// /newgame command
bot.command('newgame', async (ctx) => {
  try {
    const gameId = createNewGame();
    const miniAppLink = getMiniAppLink(gameId);
    const gameUrl = getGameUrl(gameId);
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    if (isGroup) {
      // ✅ In groups: use the t.me/Bot/AppName?startapp= link
      // This opens the Mini App directly — no redirect needed!
      await ctx.reply(
        `🎮 *New Chess Game!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '♟️ Play Chess (Mini App)', url: miniAppLink }],
              [{ text: '🌐 Open in Browser', url: gameUrl }]
            ]
          }
        }
      );
    } else {
      // Private chat — web_app button works directly
      await ctx.reply(
        `🎮 *New Chess Game!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '♟️ Open Chess Board', web_app: { url: gameUrl } }
            ]]
          }
        }
      );
    }
  } catch (err) {
    console.error('newgame error:', err);
    await ctx.reply('⚠️ Could not create game. Check server logs.');
  }
});

bot.start(async (ctx) => {
  await ctx.reply(
    '♟️ *Chess Bot*\n\nUse /newgame to start a game here.\nOr type @' + (BOT_USERNAME || 'me') + ' in any group chat to send a game invite!',
    { parse_mode: 'Markdown' }
  );
});

// ========== START ==========
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await fetchBotInfo();
  bot.launch()
    .then(() => console.log('✅ Bot online!'))
    .catch((err) => console.error('❌ Bot error:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
