require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// Optional Mongoose
let mongoose = null;
try {
  mongoose = require('mongoose');
} catch (e) {
  console.warn('⚠️ Mongoose not installed. User stats will be stored in memory (not persistent).');
}

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
let BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

BASE_URL = BASE_URL.replace(/\/$/, '');
if (BASE_URL.startsWith('http://') && !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1')) {
  BASE_URL = BASE_URL.replace('http://', 'https://');
}

console.log(`🌐 BASE_URL: ${BASE_URL}`);

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in .env file');
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== MONGODB (OPTIONAL) ==========
let User = null;
if (mongoose && MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err.message));

  const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    firstName: String,
    lastName: String,
    username: String,
    photoUrl: String,
    stats: {
      gamesPlayed: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      draws: { type: Number, default: 0 }
    },
    updatedAt: { type: Date, default: Date.now }
  });
  User = mongoose.model('User', userSchema);
} else {
  console.log('ℹ️ MongoDB not configured – user stats will be stored in memory.');
}

const memoryStats = new Map();

async function updateUserStats(userId, userInfo, result) {
  if (!userId) return;
  try {
    if (User) {
      let user = await User.findOne({ userId });
      if (!user) {
        user = new User({ userId, ...userInfo });
      } else {
        if (userInfo) {
          user.firstName = userInfo.firstName || user.firstName;
          user.lastName = userInfo.lastName || user.lastName;
          user.username = userInfo.username || user.username;
          user.photoUrl = userInfo.photoUrl || user.photoUrl;
        }
      }
      user.stats.gamesPlayed += 1;
      if (result === 'win') user.stats.wins += 1;
      else if (result === 'loss') user.stats.losses += 1;
      else if (result === 'draw') user.stats.draws += 1;
      user.updatedAt = new Date();
      await user.save();
    } else {
      let stats = memoryStats.get(userId);
      if (!stats) {
        stats = {
          userId,
          ...userInfo,
          stats: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0 }
        };
      }
      stats.stats.gamesPlayed += 1;
      if (result === 'win') stats.stats.wins += 1;
      else if (result === 'loss') stats.stats.losses += 1;
      else if (result === 'draw') stats.stats.draws += 1;
      memoryStats.set(userId, stats);
    }
    console.log(`📊 Stats updated for ${userId}: ${result}`);
  } catch (err) {
    console.error('Error updating user stats:', err);
  }
}

// ========== CHESS.JS VERSION COMPAT ==========
function chessCompat(chess) {
  return {
    isGameOver:  () => typeof chess.isGameOver  === 'function' ? chess.isGameOver()  : chess.game_over(),
    isCheckmate: () => typeof chess.isCheckmate === 'function' ? chess.isCheckmate() : chess.in_checkmate(),
    isStalemate: () => typeof chess.isStalemate === 'function' ? chess.isStalemate() : chess.in_stalemate(),
    isDraw:      () => typeof chess.isDraw      === 'function' ? chess.isDraw()      : chess.in_draw(),
    inCheck:     () => typeof chess.inCheck     === 'function' ? chess.inCheck()     : chess.in_check(),
    turn:        () => chess.turn(),
    fen:         () => chess.fen(),
    move:        (m) => chess.move(m),
  };
}

// ========== AUTO-FETCH BOT INFO ==========
let BOT_USERNAME = null;

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

// ========== MINI APP SHORT NAME ==========
function extractShortName(value) {
  if (!value) return 'game';
  const trimmed = value.trim().replace(/\/$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1];
}
const APP_SHORT_NAME = extractShortName(process.env.MINI_APP_SHORT_NAME);
console.log(`🎮 Mini App short name: ${APP_SHORT_NAME}`);

function getMiniAppLink(gameId) {
  if (!BOT_USERNAME) return null;
  return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${gameId}`;
}

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
}

// ========== TIME CONTROL CONSTANTS ==========
const DEFAULT_TIME_SEC = 10 * 60;      // 10 minutes
const TIME_5_MIN = 5 * 60;             // 5 minutes

// ========== GAME STORAGE ==========
const games = new Map();
const activeViewers = new Map();
const chatMessages = new Map();

function createNewGame(initialTimeSec = DEFAULT_TIME_SEC) {
  const gameId = uuidv4().slice(0, 8);
  const now = Date.now();
  games.set(gameId, {
    chess: new Chess(),
    whiteUserId: null,
    blackUserId: null,
    assignedPlayers: new Map(),
    pendingPlayers: [],
    lastMove: null,
    createdAt: now,
    whiteTime: initialTimeSec,
    blackTime: initialTimeSec,
    initialTime: initialTimeSec,
    lastMoveTimestamp: now,
    gameOverByTime: false,
    whitePlayerInfo: null,
    blackPlayerInfo: null,
    statsRecorded: false,
    drawOffer: null,          // null | 'white' | 'black'  (who offered)
  });
  activeViewers.set(gameId, new Map());
  chatMessages.set(gameId, []);
  return gameId;
}

function updateTimeAfterMove(game) {
  const now = Date.now();
  const elapsedSec = (now - game.lastMoveTimestamp) / 1000;
  const turn = game.chess.turn();
  if (turn === 'w') {
    game.blackTime = Math.max(0, game.blackTime - elapsedSec);
  } else {
    game.whiteTime = Math.max(0, game.whiteTime - elapsedSec);
  }
  game.lastMoveTimestamp = now;
}

function checkTimeOut(game) {
  if (game.whiteTime <= 0) {
    game.gameOverByTime = true;
    return { winner: 'black', reason: 'timeout' };
  }
  if (game.blackTime <= 0) {
    game.gameOverByTime = true;
    return { winner: 'white', reason: 'timeout' };
  }
  return null;
}

async function recordGameResult(game, explicitWinner = null) {
  if (game.statsRecorded) return;
  const c = chessCompat(game.chess);
  let winner = explicitWinner;
  let isDraw = false;

  if (game.isDraw) { isDraw = true; }
  if (!winner && !isDraw) {
    const timeOutResult = checkTimeOut(game);
    if (timeOutResult) {
      winner = timeOutResult.winner;
    } else if (c.isCheckmate()) {
      winner = c.turn() === 'w' ? 'black' : 'white';
    } else if (c.isStalemate() || c.isDraw()) {
      isDraw = true;
    }
  }

  if (winner || isDraw) {
    const whiteId = game.whiteUserId;
    const blackId = game.blackUserId;
    const whiteInfo = game.whitePlayerInfo;
    const blackInfo = game.blackPlayerInfo;

    if (whiteId) {
      if (isDraw) await updateUserStats(whiteId, whiteInfo, 'draw');
      else if (winner === 'white') await updateUserStats(whiteId, whiteInfo, 'win');
      else await updateUserStats(whiteId, whiteInfo, 'loss');
    }
    if (blackId) {
      if (isDraw) await updateUserStats(blackId, blackInfo, 'draw');
      else if (winner === 'black') await updateUserStats(blackId, blackInfo, 'win');
      else await updateUserStats(blackId, blackInfo, 'loss');
    }
    game.statsRecorded = true;
  }
}

function buildStateResponse(game, gameId) {
  const c = chessCompat(game.chess);
  let gameOver = c.isGameOver() || game.gameOverByTime;
  let checkmate = c.isCheckmate();
  let stalemate = c.isStalemate();
  let draw = c.isDraw();
  let inCheck = c.inCheck();
  let turn = c.turn();
  let winner = null;

  // Live clock: subtract elapsed time since last move for the active player.
  // This makes every poll return the true live remaining time, not a frozen snapshot.
  let liveWhiteTime = game.whiteTime;
  let liveBlackTime = game.blackTime;
  const gameStarted = !!(game.whiteUserId && game.blackUserId);
  if (gameStarted && !gameOver && game.lastMoveTimestamp) {
    const elapsedSec = (Date.now() - game.lastMoveTimestamp) / 1000;
    if (turn === 'w') {
      liveWhiteTime = Math.max(0, game.whiteTime - elapsedSec);
    } else {
      liveBlackTime = Math.max(0, game.blackTime - elapsedSec);
    }
    if (liveWhiteTime <= 0 && !game.gameOverByTime) {
      game.gameOverByTime = true; game.whiteTime = 0; liveWhiteTime = 0;
    }
    if (liveBlackTime <= 0 && !game.gameOverByTime) {
      game.gameOverByTime = true; game.blackTime = 0; liveBlackTime = 0;
    }
    gameOver = c.isGameOver() || game.gameOverByTime;
  }

  const timeOutResult = checkTimeOut(game);
  if (timeOutResult) {
    gameOver = true;
    winner = timeOutResult.winner;
  } else if (checkmate) {
    winner = turn === 'w' ? 'black' : 'white';
  }

  const viewers = activeViewers.get(gameId) || new Map();
  const spectatorCount = Math.max(0, viewers.size -
    (game.whiteUserId && viewers.has(game.whiteUserId) ? 1 : 0) -
    (game.blackUserId && viewers.has(game.blackUserId) ? 1 : 0));

  return {
    fen: c.fen(),
    turn,
    lastMove: game.lastMove,
    waitingForOpponent: !(game.whiteUserId && game.blackUserId),
    waitingForAssignment: game.pendingPlayers.length > 0,
    isGameOver: gameOver,
    isCheckmate: checkmate,
    isStalemate: stalemate,
    isDraw: draw,
    inCheck,
    winner,
    whiteTime: liveWhiteTime,
    blackTime: liveBlackTime,
    lastMoveTimestamp: game.lastMoveTimestamp,
    whiteUserId: game.whiteUserId,
    blackUserId: game.blackUserId,
    whitePlayer: game.whitePlayerInfo,
    blackPlayer: game.blackPlayerInfo,
    spectatorCount,
    drawOffer: game.drawOffer || null,
  };
}

// ========== API ROUTES ==========

app.get('/api/user/:userId/stats', async (req, res) => {
  try {
    if (User) {
      const user = await User.findOne({ userId: req.params.userId });
      if (!user) {
        return res.json({ stats: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0 } });
      }
      return res.json({ stats: user.stats });
    } else {
      const stats = memoryStats.get(req.params.userId);
      if (!stats) {
        return res.json({ stats: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0 } });
      }
      return res.json({ stats: stats.stats });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/game/new', (req, res) => {
  const { timeControl } = req.body;
  let initialSec = DEFAULT_TIME_SEC;
  if (timeControl === 5) initialSec = TIME_5_MIN;
  const gameId = createNewGame(initialSec);
  res.json({
    gameId,
    url: getGameUrl(gameId),
    miniAppLink: BOT_USERNAME ? getMiniAppLink(gameId) : null
  });
});

app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { userId, userInfo } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const viewers = activeViewers.get(gameId);
  viewers.set(userId, { lastSeen: Date.now(), userInfo });

  if (game.assignedPlayers.has(userId)) {
    return res.json({
      color: game.assignedPlayers.get(userId),
      ...buildStateResponse(game, gameId)
    });
  }

  if (game.assignedPlayers.size >= 2) {
    return res.json({ color: 'spectator', ...buildStateResponse(game, gameId) });
  }

  if (!game.pendingPlayers.includes(userId)) {
    game.pendingPlayers.push(userId);
  }

  if (game.pendingPlayers.length >= 2) {
    const [playerA, playerB] = game.pendingPlayers;
    const whiteFirst = Math.random() < 0.5;
    const whiteUser = whiteFirst ? playerA : playerB;
    const blackUser = whiteFirst ? playerB : playerA;

    game.whiteUserId = whiteUser;
    game.blackUserId = blackUser;
    game.assignedPlayers.set(whiteUser, 'white');
    game.assignedPlayers.set(blackUser, 'black');

    const whiteViewer = viewers.get(whiteUser);
    const blackViewer = viewers.get(blackUser);
    game.whitePlayerInfo = whiteViewer?.userInfo || { firstName: 'White' };
    game.blackPlayerInfo = blackViewer?.userInfo || { firstName: 'Black' };

    game.pendingPlayers = [];
    game.lastMoveTimestamp = Date.now();

    const color = game.assignedPlayers.get(userId);
    return res.json({ color, ...buildStateResponse(game, gameId) });
  }

  res.json({
    color: null,
    waitingForAssignment: true,
    ...buildStateResponse(game, gameId)
  });
});

app.post('/api/game/:gameId/heartbeat', (req, res) => {
  const { gameId } = req.params;
  const { userId, userInfo } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const viewers = activeViewers.get(gameId);
  if (viewers) {
    viewers.set(userId, { lastSeen: Date.now(), userInfo });
  }
  res.json({ ok: true });
});

function stateHandler(req, res) {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(buildStateResponse(game, req.params.gameId));
}

app.get('/api/game/:gameId/state', stateHandler);
app.get('/api/game/:gameId', stateHandler);

app.post('/api/game/:gameId/move', async (req, res) => {
  const { gameId } = req.params;
  const { userId, from, to, promotion } = req.body;
  if (!userId || !from || !to) return res.status(400).json({ error: 'userId, from, to required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.assignedPlayers.get(userId);
  if (!playerColor || playerColor === 'spectator') {
    return res.status(403).json({ error: 'You are not a player in this game' });
  }

  const c = chessCompat(game.chess);
  const currentTurn = c.turn();
  if ((currentTurn === 'w' && playerColor !== 'white') ||
      (currentTurn === 'b' && playerColor !== 'black')) {
    return res.status(403).json({ error: 'Not your turn' });
  }

  if (!game.whiteUserId || !game.blackUserId) {
    return res.status(400).json({ error: 'Waiting for opponent to join' });
  }

  const timeOutResult = checkTimeOut(game);
  if (timeOutResult) {
    return res.status(400).json({ error: 'Game already ended by timeout' });
  }

  try {
    const result = c.move({ from, to, promotion: promotion || 'q' });
    if (!result) return res.status(400).json({ error: 'Invalid move' });

    updateTimeAfterMove(game);
    game.lastMove = { from: result.from, to: result.to };
    
    const response = { success: true, move: result, ...buildStateResponse(game, gameId) };
    
    if (c.isGameOver()) {
      await recordGameResult(game);
    }
    
    res.json(response);
  } catch (err) {
    res.status(400).json({ error: 'Invalid move: ' + err.message });
  }
});

app.post('/api/game/:gameId/resign', async (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.assignedPlayers.get(userId);
  if (!playerColor || playerColor === 'spectator') {
    return res.status(403).json({ error: 'Only players can resign' });
  }

  if (!game.whiteUserId || !game.blackUserId) {
    return res.status(400).json({ error: 'Game has not started' });
  }

  if (game.gameOverByTime || chessCompat(game.chess).isGameOver()) {
    return res.status(400).json({ error: 'Game already over' });
  }

  game.gameOverByTime = true;
  const winner = playerColor === 'white' ? 'black' : 'white';
  
  await recordGameResult(game, winner);
  
  res.json({
    success: true,
    winner,
    ...buildStateResponse(game, gameId)
  });
});


// ========== DRAW OFFER ENDPOINTS ==========

app.post('/api/game/:gameId/draw-offer', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.assignedPlayers.get(userId);
  if (!playerColor || playerColor === 'spectator')
    return res.status(403).json({ error: 'Only players can offer a draw' });
  if (!game.whiteUserId || !game.blackUserId)
    return res.status(400).json({ error: 'Game has not started' });
  if (game.gameOverByTime || chessCompat(game.chess).isGameOver())
    return res.status(400).json({ error: 'Game already over' });
  if (game.drawOffer)
    return res.status(400).json({ error: 'Draw already offered' });

  game.drawOffer = playerColor;
  res.json({ success: true, drawOffer: playerColor, ...buildStateResponse(game, gameId) });
});

app.post('/api/game/:gameId/draw-accept', async (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.assignedPlayers.get(userId);
  if (!playerColor || playerColor === 'spectator')
    return res.status(403).json({ error: 'Only players can accept a draw' });
  if (!game.drawOffer)
    return res.status(400).json({ error: 'No draw offer pending' });
  if (game.drawOffer === playerColor)
    return res.status(400).json({ error: 'Cannot accept your own draw offer' });

  game.drawOffer = null;
  game.gameOverByTime = true;   // reuse flag to end the game
  game.isDraw = true;

  await recordGameResult(game);  // records as draw

  res.json({ success: true, isDraw: true, winner: null, ...buildStateResponse(game, gameId) });
});

app.post('/api/game/:gameId/draw-decline', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.assignedPlayers.get(userId);
  if (!playerColor || playerColor === 'spectator')
    return res.status(403).json({ error: 'Only players can decline a draw' });
  if (!game.drawOffer)
    return res.status(400).json({ error: 'No draw offer pending' });

  game.drawOffer = null;
  res.json({ success: true, drawOffer: null, ...buildStateResponse(game, gameId) });
});

// ========== CHAT ENDPOINTS ==========
app.post('/api/game/:gameId/chat', (req, res) => {
  const { gameId } = req.params;
  const { userId, text } = req.body;
  if (!userId || !text || text.trim().length === 0) {
    return res.status(400).json({ error: 'userId and text required' });
  }

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let color = 'spectator';
  if (game.whiteUserId === userId) color = 'white';
  else if (game.blackUserId === userId) color = 'black';

  let name = 'Anonymous';
  if (color === 'white' && game.whitePlayerInfo) {
    name = game.whitePlayerInfo.firstName || 'White';
  } else if (color === 'black' && game.blackPlayerInfo) {
    name = game.blackPlayerInfo.firstName || 'Black';
  } else {
    const viewers = activeViewers.get(gameId);
    const viewer = viewers?.get(userId);
    if (viewer?.userInfo) name = viewer.userInfo.firstName || 'Spectator';
  }

  const timestamp = Date.now();
  const message = {
    userId,
    name,
    color,
    text: text.trim(),
    timestamp
  };

  const messages = chatMessages.get(gameId) || [];
  messages.push(message);
  if (messages.length > 100) messages.shift();
  chatMessages.set(gameId, messages);

  res.json({ success: true, message });
});

app.get('/api/game/:gameId/chat', (req, res) => {
  const { gameId } = req.params;
  const since = parseInt(req.query.since) || 0;

  const messages = chatMessages.get(gameId) || [];
  const newMessages = messages.filter(m => m.timestamp > since);
  res.json({ messages: newMessages });
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [gameId, viewers] of activeViewers.entries()) {
    for (const [userId, data] of viewers.entries()) {
      if (now - data.lastSeen > 30000) {
        viewers.delete(userId);
      }
    }
  }

  for (const [id, game] of games.entries()) {
    if (now - game.createdAt > 3600000) {
      games.delete(id);
      activeViewers.delete(id);
      chatMessages.delete(id);
    }
  }
}, 60000);

// ========== TELEGRAM BOT ==========
const bot = new Telegraf(BOT_TOKEN);

bot.on('inline_query', async (ctx) => {
  if (!BOT_USERNAME) {
    console.warn('Inline query received before BOT_USERNAME fetched');
    return await ctx.answerInlineQuery([], { cache_time: 0 });
  }

  const gameId5 = createNewGame(TIME_5_MIN);
  const gameId10 = createNewGame(DEFAULT_TIME_SEC);
  const miniAppLink5 = getMiniAppLink(gameId5);
  const miniAppLink10 = getMiniAppLink(gameId10);
  
  if (!miniAppLink5 || !miniAppLink10) {
    console.error('Failed to generate mini app link');
    return await ctx.answerInlineQuery([], { cache_time: 0 });
  }

  await ctx.answerInlineQuery([
    {
      type: 'article',
      id: gameId5,
      title: '♟️ Chess · 5 min',
      description: 'Blitz game – 5 minutes each',
      thumbnail_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Chess_kdt45.svg/45px-Chess_kdt45.svg.png',
      input_message_content: {
        message_text: `🎮 *Chess · 5 min*\n\nGame ID: \`${gameId5}\`\n\n⚔️ First two to join play\n🎲 Colors assigned randomly\n⏱️ Time: 5 min each\n\nTap below to play!`,
        parse_mode: 'Markdown'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '♟️ Play Chess', url: miniAppLink5 }
        ]]
      }
    },
    {
      type: 'article',
      id: gameId10,
      title: '♟️ Chess · 10 min',
      description: 'Standard game – 10 minutes each',
      thumbnail_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Chess_kdt45.svg/45px-Chess_kdt45.svg.png',
      input_message_content: {
        message_text: `🎮 *Chess · 10 min*\n\nGame ID: \`${gameId10}\`\n\n⚔️ First two to join play\n🎲 Colors assigned randomly\n⏱️ Time: 10 min each\n\nTap below to play!`,
        parse_mode: 'Markdown'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '♟️ Play Chess', url: miniAppLink10 }
        ]]
      }
    }
  ], { cache_time: 0 });
});

bot.command('newgame', async (ctx) => {
  try {
    const messageText = ctx.message.text;
    const args = messageText.split(' ');
    let timeMinutes = 10;
    if (args.length >= 2) {
      const parsed = parseInt(args[1]);
      if (parsed === 5 || parsed === 10) timeMinutes = parsed;
    }
    const initialSec = timeMinutes === 5 ? TIME_5_MIN : DEFAULT_TIME_SEC;

    const gameId = createNewGame(initialSec);
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const miniAppLink = getMiniAppLink(gameId);
    const webAppUrl = getGameUrl(gameId);

    const timeLabel = timeMinutes === 5 ? '5 min' : '10 min';
    const messageTextOut = `🎮 *New Chess Game · ${timeLabel}*\n\nGame ID: \`${gameId}\`\n\n⚔️ First two to join play\n🎲 Colors assigned randomly\n⏱️ Time: ${timeLabel} each`;

    if (isGroup) {
      await ctx.reply(messageTextOut, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '♟️ Play Chess', url: miniAppLink }]
          ]
        }
      });
    } else {
      await ctx.reply(messageTextOut, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '♟️ Play Now', web_app: { url: webAppUrl } }],
            [{ text: '🔗 Game Link', url: miniAppLink }]
          ]
        }
      });
    }
  } catch (err) {
    console.error('newgame error:', err);
    await ctx.reply('⚠️ Could not create game. Check server logs.');
  }
});

bot.start(async (ctx) => {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) {
    return ctx.reply(
      `♟️ *Chess Bot*\n\nUse /newgame to start a game in this group!`,
      { parse_mode: 'Markdown' }
    );
  }

  const inviteMessage = `👋 *Want to play chess with any contact from Telegram?*

It's very easy to do so, click the button below or go to the chat which you want to send the invitation to, type in *@${BOT_USERNAME}* , and add a space.

You can also send the invitation to a group or channel. In that case, the first person to click the 'Join' button will be your opponent.`;

  await ctx.reply(inviteMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{
          text: '📤 Send Game Invite',
          switch_inline_query: ''
        }]
      ]
    }
  });
});

// ========== START ==========
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await fetchBotInfo();
  try {
    await bot.launch();
    console.log('✅ Bot online!');
  } catch (err) {
    console.error('❌ Bot launch error:', err.message);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));