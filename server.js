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
let BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Force HTTPS for Telegram WebApp (unless localhost for testing)
if (BASE_URL.startsWith('http://') && !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1')) {
  BASE_URL = BASE_URL.replace('http://', 'https://');
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game storage: gameId -> { chess, whiteUserId, blackUserId, clients: Map, createdAt }
const games = new Map();

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
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
  res.json({ gameId, url: getGameUrl(gameId) });
});

app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let assignedColor = game.clients.get(userId);
  if (!assignedColor) {
    // Assign colors in order of joining
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

  res.json({
    color: assignedColor,
    fen: game.chess.fen(),
    turn: game.chess.turn(),
    isGameOver: game.chess.isGameOver(),
    winner: game.chess.isCheckmate() ? (game.chess.turn() === 'w' ? 'black' : 'white') : null,
    inCheck: game.chess.inCheck(),
    waitingForOpponent: !game.whiteUserId || !game.blackUserId
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
    lastMove: game.lastMove || null,
    waitingForOpponent: !game.whiteUserId || !game.blackUserId
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

  if (!game.whiteUserId || !game.blackUserId) {
    return res.status(400).json({ error: 'Waiting for opponent' });
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
    'Both players click the same button – colors are assigned automatically (first joiner = White, second = Black).\n\n' +
    'The game opens inside Telegram.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('newgame', async (ctx) => {
  try {
    const response = await fetch(`${BASE_URL}/api/game/new`, { method: 'POST' });
    const { gameId, url } = await response.json();

    await ctx.reply(
      `🎮 *New Chess Game Created!*\nGame ID: \`${gameId}\`\n\nShare this button with your friend:`,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply('♟️ **Click to join the game** (colors assigned randomly by join order):', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎲 Join Chess Game', web_app: { url } }]
        ]
      }
    });
  } catch (err) {
    console.error(err);
    ctx.reply('Sorry, could not create game. Please try again.');
  }
});

bot.launch();
console.log(`Bot started. Mini App URL: ${BASE_URL}`);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
