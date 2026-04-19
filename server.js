require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game storage: gameId -> { chess, whiteUserId, blackUserId, clients: Map, createdAt }
const games = new Map();

// Helper: generate full game URL for WebApp
function getGameUrl(gameId, color = null) {
  let url = `${BASE_URL}/?game=${gameId}`;
  if (color) url += `&color=${color}`;
  return url;
}

// API Routes

app.post('/api/game/new', (req, res) => {
  const gameId = uuidv4().slice(0, 8);
  const chess = new Chess();
  games.set(gameId, {
    chess,
    whiteUserId: null,
    blackUserId: null,
    clients: new Map(), // telegramUserId -> color
    createdAt: Date.now()
  });
  res.json({
    gameId,
    whiteUrl: getGameUrl(gameId, 'white'),
    blackUrl: getGameUrl(gameId, 'black')
  });
});

app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { userId, preferredColor } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let assignedColor = game.clients.get(userId);
  if (!assignedColor) {
    if (preferredColor === 'white' && !game.whiteUserId) {
      assignedColor = 'white';
      game.whiteUserId = userId;
    } else if (preferredColor === 'black' && !game.blackUserId) {
      assignedColor = 'black';
      game.blackUserId = userId;
    } else if (!game.whiteUserId) {
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

  res.json({
    color: assignedColor,
    fen: game.chess.fen(),
    turn: game.chess.turn(),
    isGameOver: game.chess.isGameOver(),
    winner: game.chess.isCheckmate() ? (game.chess.turn() === 'w' ? 'black' : 'white') : null,
    inCheck: game.chess.inCheck()
  });
});

app.get('/api/game/:gameId/state', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.query;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const color = game.clients.get(userId) || null;
  const chess = game.chess;
  res.json({
    color,
    fen: chess.fen(),
    turn: chess.turn(),
    isGameOver: chess.isGameOver(),
    winner: chess.isCheckmate() ? (chess.turn() === 'w' ? 'black' : 'white') : null,
    inCheck: chess.inCheck(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    lastMove: game.lastMove || null
  });
});

app.post('/api/game/:gameId/move', (req, res) => {
  const { gameId } = req.params;
  const { userId, from, to, promotion = 'q' } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const color = game.clients.get(userId);
  if (color !== 'white' && color !== 'black') {
    return res.status(403).json({ error: 'You are not a player' });
  }

  const expectedTurn = color === 'white' ? 'w' : 'b';
  if (game.chess.turn() !== expectedTurn) {
    return res.status(400).json({ error: 'Not your turn' });
  }

  try {
    const move = game.chess.move({ from, to, promotion });
    if (!move) return res.status(400).json({ error: 'Invalid move' });
    game.lastMove = { from, to };
    res.json({
      success: true,
      fen: game.chess.fen(),
      turn: game.chess.turn(),
      isGameOver: game.chess.isGameOver(),
      winner: game.chess.isCheckmate() ? (game.chess.turn() === 'w' ? 'black' : 'white') : null,
      inCheck: game.chess.inCheck(),
      move
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cleanup old games
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    if (now - game.createdAt > 3600000) games.delete(id);
  }
}, 600000);

// Telegram Bot

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    '♟️ *Multiplayer Chess Mini App* ♞\n\n' +
    'Use /newgame to create a chess game and invite a friend.\n' +
    'The game will open inside Telegram as a Mini App.\n\n' +
    'Each player will get a separate button (White / Black).',
    { parse_mode: 'Markdown' }
  );
});

bot.command('newgame', async (ctx) => {
  try {
    const response = await fetch(`${BASE_URL}/api/game/new`, { method: 'POST' });
    const { gameId, whiteUrl, blackUrl } = await response.json();

    // Send two separate messages with WebApp buttons
    await ctx.reply(
      `🎮 *New Chess Game Created!*\nGame ID: \`${gameId}\``,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply('👑 **White Player** – click below to play:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '♔ Play as White', web_app: { url: whiteUrl } }]
        ]
      }
    });

    await ctx.reply('♟️ **Black Player** – click below to play:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '♚ Play as Black', web_app: { url: blackUrl } }]
        ]
      }
    });

    // Also send a shareable game link (optional)
    await ctx.reply(`Or share this link: ${BASE_URL}/?game=${gameId}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Open Game', url: `${BASE_URL}/?game=${gameId}` }]
        ]
      }
    });
  } catch (err) {
    console.error(err);
    ctx.reply('Sorry, could not create game. Please try again.');
  }
});

bot.launch();

// Express serves the Mini App HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  console.log(`Bot ready. Mini App URL: ${BASE_URL}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
