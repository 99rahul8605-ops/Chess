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

// Force HTTPS for Telegram WebApp (except localhost for testing)
if (BASE_URL.startsWith('http://') && !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1')) {
  BASE_URL = BASE_URL.replace('http://', 'https://');
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game storage
const games = new Map(); // gameId -> { chess, whiteUserId, blackUserId, clients: Map, createdAt }

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
}

// ========== API ROUTES ==========

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

// Clean up old games (1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    if (now - game.createdAt > 3600000) games.delete(id);
  }
}, 600000);

// ========== TELEGRAM BOT ==========
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  if (isGroup) {
    ctx.reply(
      '♟️ *Chess Bot ready!*\nUse /newgame to create a game.\n\nFirst player to click the button gets White, second gets Black.\n\n⚠️ Make sure my privacy mode is disabled (ask group admin to set /setprivacy with @BotFather).',
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.reply(
      '♟️ *Multiplayer Chess Mini App* ♞\n\n' +
      'Use /newgame to create a chess game and invite a friend.\n' +
      'Both players click the same button – colors are assigned automatically (first joiner = White, second = Black).\n\n' +
      'You can also add me to a group and use /newgame there.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('newgame', async (ctx) => {
  try {
    const response = await fetch(`${BASE_URL}/api/game/new`, { method: 'POST' });
    const { gameId, url } = await response.json();

    const messageText = `🎮 *New Chess Game Created!*\nGame ID: \`${gameId}\`\n\nClick the button below to join. First player gets White, second gets Black.`;

    await ctx.reply(messageText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '♟️ Join Chess Game', web_app: { url } }]
        ]
      }
    });
  } catch (err) {
    console.error(err);
    ctx.reply('Sorry, could not create game. Please try again.');
  }
});

// Welcome message when bot joins a group
bot.on('new_chat_members', (ctx) => {
  const newMember = ctx.message.new_chat_members.find(m => m.id === ctx.botInfo.id);
  if (newMember) {
    ctx.reply(
      '👋 Hello! I am a Chess bot.\n\nUse /newgame to create a game.\n\n⚠️ Make sure my privacy mode is disabled (ask the group admin to set /setprivacy with @BotFather).',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.launch();
console.log(`Bot started. Mini App URL: ${BASE_URL}`);

// ========== SERVER ==========
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
