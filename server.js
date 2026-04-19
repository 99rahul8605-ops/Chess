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

// Force HTTPS for Telegram WebApp
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
    // Call the internal API to initialize a game
    const response = await fetch(`${BASE_URL}/api/game/new`, { method: 'POST' });
    if (!response.ok) throw new Error('API server unreachable');
    
    const { gameId, url } = await response.json();

    const messageText = `🎮 *New Chess Game Created!*\nGame ID: \`${gameId}\`\n\nClick below to join.`;
    
    // Check if it is a group/supergroup
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

    const replyMarkup = {
      inline_keyboard: [
        [
          { 
            text: '♟️ Play Chess', 
            // Groups get a 'url' button, Private gets a 'web_app' button
            // This prevents the BUTTON_TYPE_INVALID error
            ...(isGroup ? { url: url } : { web_app: { url: url } })
          }
        ]
      ]
    };
    
    await ctx.reply(messageText, { 
      parse_mode: 'Markdown', 
      reply_markup: replyMarkup 
    });
  } catch (err) {
    console.error('Create game error:', err);
    // Don't let the bot crash on error
    try {
      await ctx.reply('⚠️ Failed to create game. Ensure the server BASE_URL is correct and reachable.');
    } catch (e) {}
  }
}

bot.start((ctx) => {
  ctx.reply('♟️ *Chess Mini App ready!* Send /newgame to start.', { parse_mode: 'Markdown' });
});

bot.command('newgame', async (ctx) => {
  await createGame(ctx);
});

// Start Express first
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Launch Bot after server is up
  bot.launch()
    .then(() => console.log('Bot successfully launched!'))
    .catch((err) => console.error('Bot launch failed:', err));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
