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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game storage
const games = new Map(); // gameId -> { chess, whiteClientId, blackClientId, clients: Map, createdAt }

// Bot setup
const bot = new Telegraf(BOT_TOKEN);

// Helper: Generate game link
function getGameLink(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
}

// API Routes

// Create new game
app.post('/api/game/new', (req, res) => {
  const gameId = uuidv4().slice(0, 8);
  const chess = new Chess();
  
  games.set(gameId, {
    chess,
    whiteClientId: null,
    blackClientId: null,
    clients: new Map(), // clientId -> color
    createdAt: Date.now()
  });
  
  res.json({ 
    gameId, 
    link: getGameLink(gameId),
    whiteLink: `${getGameLink(gameId)}&color=white`,
    blackLink: `${getGameLink(gameId)}&color=black`
  });
});

// Join game
app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { clientId, preferredColor } = req.body;
  
  const game = games.get(gameId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  // Check if client already has a color
  let assignedColor = game.clients.get(clientId);
  
  if (!assignedColor) {
    // Assign color based on availability
    if (preferredColor === 'white' && !game.whiteClientId) {
      assignedColor = 'white';
      game.whiteClientId = clientId;
    } else if (preferredColor === 'black' && !game.blackClientId) {
      assignedColor = 'black';
      game.blackClientId = clientId;
    } else if (!game.whiteClientId) {
      assignedColor = 'white';
      game.whiteClientId = clientId;
    } else if (!game.blackClientId) {
      assignedColor = 'black';
      game.blackClientId = clientId;
    } else {
      assignedColor = 'spectator';
    }
    
    game.clients.set(clientId, assignedColor);
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

// Get game state
app.get('/api/game/:gameId/state', (req, res) => {
  const { gameId } = req.params;
  const { clientId } = req.query;
  
  const game = games.get(gameId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  const color = game.clients.get(clientId) || 'spectator';
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

// Make a move
app.post('/api/game/:gameId/move', (req, res) => {
  const { gameId } = req.params;
  const { clientId, from, to, promotion = 'q' } = req.body;
  
  const game = games.get(gameId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  const color = game.clients.get(clientId);
  const chess = game.chess;
  
  // Validate player color and turn
  if (color !== 'white' && color !== 'black') {
    return res.status(403).json({ error: 'You are a spectator' });
  }
  
  const expectedTurn = color === 'white' ? 'w' : 'b';
  if (chess.turn() !== expectedTurn) {
    return res.status(400).json({ error: 'Not your turn' });
  }
  
  // Attempt the move
  try {
    const move = chess.move({ from, to, promotion });
    if (!move) {
      return res.status(400).json({ error: 'Invalid move' });
    }
    
    game.lastMove = { from, to };
    
    res.json({
      success: true,
      fen: chess.fen(),
      turn: chess.turn(),
      isGameOver: chess.isGameOver(),
      winner: chess.isCheckmate() ? (chess.turn() === 'w' ? 'black' : 'white') : null,
      inCheck: chess.inCheck(),
      move
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Clean up old games (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [gameId, game] of games.entries()) {
    if (now - game.createdAt > 3600000) {
      games.delete(gameId);
    }
  }
}, 600000);

// Telegram Bot Commands

bot.start((ctx) => {
  ctx.reply(
    '♟️ *Welcome to Multiplayer Chess Bot!* ♞\n\n' +
    'Use /newgame to create a new chess game and invite a friend to play.\n\n' +
    'Each player will get a unique link to the chess board. Share the black player link with your opponent!\n\n' +
    'The game is played in real-time in your browser.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('newgame', async (ctx) => {
  try {
    const response = await fetch(`${BASE_URL}/api/game/new`, {
      method: 'POST'
    });
    const { gameId, whiteLink, blackLink } = await response.json();
    
    const gameUrl = `${BASE_URL}/?game=${gameId}`;
    
    ctx.reply(
      '🎮 *New Chess Game Created!* 🎮\n\n' +
      `Game ID: \`${gameId}\`\n\n` +
      '*Share these links:*\n' +
      `👑 White Player: ${whiteLink}\n` +
      `♟️ Black Player: ${blackLink}\n\n` +
      'Click the link to join the game. First player to join gets white, second gets black.',
      { parse_mode: 'Markdown' }
    );
    
    // Send inline keyboard for easy sharing
    ctx.reply('Share with a friend:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎮 Copy White Link', callback_data: `copy_${whiteLink}` },
            { text: '♟️ Copy Black Link', callback_data: `copy_${blackLink}` }
          ],
          [{ text: '📱 Open Game', url: gameUrl }]
        ]
      }
    });
  } catch (error) {
    console.error('Error creating game:', error);
    ctx.reply('Sorry, there was an error creating the game. Please try again.');
  }
});

bot.action(/copy_(.+)/, async (ctx) => {
  const url = ctx.match[1];
  ctx.answerCbQuery();
  ctx.reply(`🔗 Here's your link:\n${url}`);
});

bot.launch();

// Express server
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Bot URL: ${BASE_URL}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
