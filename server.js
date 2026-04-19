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

// Force HTTPS for Telegram WebApp (Telegram requires HTTPS for Mini Apps)
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

  const chess = game.chess;
  res.json({
    color: assignedColor,
    fen: chess.fen(),
    turn: chess.turn(),
    isGameOver: chess.game_over(),
    winner: chess.in_checkmate() ? (chess.turn() === 'w' ? 'black' : 'white') : null,
    inCheck: chess.in_check(),
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
    isGameOver: chess.game_over(),
    winner: chess.in_checkmate() ? (chess.turn() === 'w' ? 'black' : 'white') : null,
    inCheck: chess.in_check(),
    isStalemate: chess.in_stalemate(),
    isDraw: chess.in_draw(),
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
      isGameOver: game.chess.game_over(),
      winner: game.chess.in_checkmate() ? (game.chess.turn() === 'w' ? 'black' : 'white') : null,
      inCheck: game.chess.in_check(),
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

async function createGame(ctx) {
  try {
    // Note: Calling your own API works, but in production, you could just call the logic directly
    const response = await fetch(`${BASE_URL}/api/game/new`, { method: 'POST' });
    const { gameId, url } = await response.json();

    const messageText = `🎮 *New Chess Game Created!*\nGame ID: \`${gameId}\`\n\nClick below to join the game.`;
    
    // FIX: This now uses web_app for both groups and private chats
    const replyMarkup = {
      inline_keyboard: [
        [{ text: '♟️ Play Chess', web_app: { url: url } }]
      ]
    };
    
    await ctx.reply(messageText, { 
      parse_mode: 'Markdown', 
      reply_markup: replyMarkup 
    });
  } catch (err) {
    console.error('Create game error:', err);
    ctx.reply('Sorry, could not create game. Please check if the server is running.');
  }
}

bot.start((ctx) => {
  ctx.reply(
    '♟️ *Multiplayer Chess Mini App*\n\n' +
    'Use /newgame to create a chess game.\n' +
    'The game will open as a Mini App directly inside Telegram.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('newgame', async (ctx) => {
  await createGame(ctx);
});

// Handle new members to show instructions
bot.on('new_chat_members', (ctx) => {
  const isBotAdded = ctx.message.new_chat_members.find(m => m.id === ctx.botInfo.id);
  if (isBotAdded) {
    ctx.reply('👋 I am ready! Send /newgame to start a match in this group.');
  }
});

bot.launch();
console.log(`Bot running. Base URL: ${BASE_URL}`);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
