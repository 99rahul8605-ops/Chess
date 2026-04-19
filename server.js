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

// ========== BOT USERNAME (auto-fetched via Bot API) ==========
let BOT_USERNAME = null;

async function fetchBotUsername() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok) {
      BOT_USERNAME = data.result.username;
      console.log(`✅ Bot username fetched: @${BOT_USERNAME}`);
    } else {
      console.error('❌ getMe failed:', data.description);
    }
  } catch (err) {
    console.error('❌ Could not fetch bot username:', err.message);
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

// ========== API ROUTES ==========

app.post('/api/game/new', (req, res) => {
  const gameId = createNewGame();
  res.json({ gameId, url: getGameUrl(gameId) });
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

// Cleanup old games every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    if (now - game.createdAt > 3600000) games.delete(id);
  }
}, 600000);

// ========== TELEGRAM BOT ==========
const bot = new Telegraf(BOT_TOKEN);

// Handle deep-link: /start game_GAMEID
// User clicks group button → opens private chat → bot sends web_app button
bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload && payload.startsWith('game_')) {
    const gameId = payload.replace('game_', '');
    const game = games.get(gameId);

    if (!game) {
      return ctx.reply('⚠️ This game has expired. Ask the group to create a new one with /newgame.');
    }

    // ✅ Private chat — web_app button is fully supported here
    await ctx.reply(
      `🎮 *Chess Game: \`${gameId}\`*\n\n♔ 1st player = White\n♚ 2nd player = Black\n\nTap below to open the board:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '♟️ Open Chess Board', web_app: { url: getGameUrl(gameId) } }
          ]]
        }
      }
    );
  } else {
    await ctx.reply(
      '♟️ *Chess Bot*\n\nAdd me to a group and use /newgame to challenge friends!\nOr use /newgame here for a private game.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('newgame', async (ctx) => {
  try {
    const gameId = createNewGame();
    const gameUrl = getGameUrl(gameId);
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    if (isGroup) {
      // Build deep-link using auto-fetched BOT_USERNAME
      const deepLink = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?start=game_${gameId}`
        : null;

      const inlineKeyboard = [];

      if (deepLink) {
        // Button 1: Deep-link → private chat → bot sends web_app button there
        inlineKeyboard.push([{ text: '🤖 Play via Bot (Mini App)', url: deepLink }]);
      }

      // Button 2: Direct browser fallback — always available
      inlineKeyboard.push([{ text: '🌐 Open in Browser', url: gameUrl }]);

      await ctx.reply(
        `🎮 *New Chess Game!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black\n\n👇 Choose how to play:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: inlineKeyboard }
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

// ========== START ==========
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);

  // Fetch bot username from Telegram API before launching bot
  await fetchBotUsername();

  bot.launch()
    .then(() => console.log('✅ Bot online!'))
    .catch((err) => console.error('❌ Bot error:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
