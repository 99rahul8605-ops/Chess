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

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== SHARED GAME STORAGE ==========
const games = new Map();

function createNewGame() {
  const gameId = uuidv4().slice(0, 8);
  const chess = new Chess();
  games.set(gameId, {
    chess,
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

async function createGame(ctx) {
  try {
    // ✅ KEY FIX: Create game directly in memory — NO self-fetch
    // Self-fetch on Render free tier causes the server to hang/timeout
    const gameId = createNewGame();
    const gameUrl = getGameUrl(gameId);

    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    // ✅ Groups only support 'url' buttons — 'web_app' buttons are blocked in groups
    const replyMarkup = {
      inline_keyboard: [[
        isGroup
          ? { text: '♟️ Join & Play Chess', url: gameUrl }
          : { text: '♟️ Open Chess Game', web_app: { url: gameUrl } }
      ]]
    };

    await ctx.reply(
      `🎮 *New Chess Game Created!*\n\nGame ID: \`${gameId}\`\n\n1st player = ♔ White\n2nd player = ♚ Black\n\nClick below to join!`,
      { parse_mode: 'Markdown', reply_markup: replyMarkup }
    );

  } catch (err) {
    console.error('createGame error:', err);
    await ctx.reply('⚠️ Could not create game. Check server logs.');
  }
}

bot.start((ctx) => ctx.reply('♟️ Chess Bot ready!\n\nUse /newgame to start a game.'));
bot.command('newgame', (ctx) => createGame(ctx));

// ========== START ==========
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 BASE_URL: ${BASE_URL}`);
  bot.launch()
    .then(() => console.log('✅ Bot online!'))
    .catch((err) => console.error('❌ Bot error:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
