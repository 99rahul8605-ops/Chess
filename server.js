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
const INITIAL_TIME_SEC = 10 * 60; // 10 minutes per player

// ========== GAME STORAGE ==========
const games = new Map();

function createNewGame() {
  const gameId = uuidv4().slice(0, 8);
  const now = Date.now();
  games.set(gameId, {
    chess: new Chess(),
    whiteUserId: null,
    blackUserId: null,
    players: new Map(),
    lastMove: null,
    createdAt: now,
    // Time control fields
    whiteTime: INITIAL_TIME_SEC,
    blackTime: INITIAL_TIME_SEC,
    lastMoveTimestamp: now,       // when the last move was made (or game start)
    gameOverByTime: false,
  });
  return gameId;
}

// Helper to update time for the player who just moved
function updateTimeAfterMove(game) {
  const now = Date.now();
  const elapsedSec = (now - game.lastMoveTimestamp) / 1000;
  const turn = game.chess.turn(); // after move, turn is opposite of who just moved
  if (turn === 'w') {
    // Black just moved
    game.blackTime = Math.max(0, game.blackTime - elapsedSec);
  } else {
    // White just moved
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

function buildStateResponse(game) {
  const c = chessCompat(game.chess);
  let gameOver = c.isGameOver() || game.gameOverByTime;
  let checkmate = c.isCheckmate();
  let stalemate = c.isStalemate();
  let draw = c.isDraw();
  let inCheck = c.inCheck();
  let turn = c.turn();
  let winner = null;

  // Check time out first
  const timeOutResult = checkTimeOut(game);
  if (timeOutResult) {
    gameOver = true;
    winner = timeOutResult.winner;
  } else if (checkmate) {
    winner = turn === 'w' ? 'black' : 'white';
  }

  return {
    fen: c.fen(),
    turn,
    lastMove: game.lastMove,
    waitingForOpponent: !(game.whiteUserId && game.blackUserId),
    isGameOver: gameOver,
    isCheckmate: checkmate,
    isStalemate: stalemate,
    isDraw: draw,
    inCheck,
    winner,
    whiteTime: game.whiteTime,
    blackTime: game.blackTime,
    lastMoveTimestamp: game.lastMoveTimestamp,
  };
}

// ========== API ROUTES ==========

app.post('/api/game/new', (req, res) => {
  const gameId = createNewGame();
  res.json({
    gameId,
    url: getGameUrl(gameId),
    miniAppLink: BOT_USERNAME ? getMiniAppLink(gameId) : null
  });
});

app.post('/api/game/:gameId/join', (req, res) => {
  const { gameId } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  if (game.players.has(userId)) {
    return res.json({ color: game.players.get(userId), ...buildStateResponse(game) });
  }

  let assignedColor;
  if (!game.whiteUserId) {
    assignedColor = 'white';
    game.whiteUserId = userId;
  } else if (!game.blackUserId) {
    assignedColor = 'black';
    game.blackUserId = userId;
  } else {
    assignedColor = 'spectator';
  }

  if (assignedColor !== 'spectator') {
    game.players.set(userId, assignedColor);
  }

  res.json({ color: assignedColor, ...buildStateResponse(game) });
});

function stateHandler(req, res) {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(buildStateResponse(game));
}

app.get('/api/game/:gameId/state', stateHandler);
app.get('/api/game/:gameId', stateHandler);

app.post('/api/game/:gameId/move', (req, res) => {
  const { gameId } = req.params;
  const { userId, from, to, promotion } = req.body;
  if (!userId || !from || !to) return res.status(400).json({ error: 'userId, from, to required' });

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const playerColor = game.players.get(userId);
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

  // Check time out before move
  const timeOutResult = checkTimeOut(game);
  if (timeOutResult) {
    return res.status(400).json({ error: 'Game already ended by timeout' });
  }

  try {
    const result = c.move({ from, to, promotion: promotion || 'q' });
    if (!result) return res.status(400).json({ error: 'Invalid move' });

    // Update time for the player who just moved
    updateTimeAfterMove(game);

    game.lastMove = { from: result.from, to: result.to };
    res.json({ success: true, move: result, ...buildStateResponse(game) });
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

bot.on('inline_query', async (ctx) => {
  // Ensure bot username is available
  if (!BOT_USERNAME) {
    console.warn('Inline query received before BOT_USERNAME fetched');
    return await ctx.answerInlineQuery([], { cache_time: 0 });
  }

  const gameId = createNewGame();
  const miniAppLink = getMiniAppLink(gameId);
  if (!miniAppLink) {
    console.error('Failed to generate mini app link');
    return await ctx.answerInlineQuery([], { cache_time: 0 });
  }

  await ctx.answerInlineQuery([
    {
      type: 'article',
      id: gameId,
      title: '♟️ Start a Chess Game (10 min)',
      description: 'Send a timed chess game invite to this chat',
      thumbnail_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Chess_kdt45.svg/45px-Chess_kdt45.svg.png',
      input_message_content: {
        message_text: `🎮 *Chess Game Challenge!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black\n⏱️ Time control: 10 min each\n\nTap below to play!`,
        parse_mode: 'Markdown'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '♟️ Play Chess', url: miniAppLink }
        ]]
      }
    }
  ], { cache_time: 0 });
});

bot.command('newgame', async (ctx) => {
  try {
    const gameId = createNewGame();
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const miniAppLink = getMiniAppLink(gameId);
    const webAppUrl = getGameUrl(gameId);

    const messageText = `🎮 *New Chess Game!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black\n⏱️ Time: 10 min each`;

    if (isGroup) {
      await ctx.reply(messageText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '♟️ Play Chess (Mini App)', url: miniAppLink }],
            [{ text: '🌐 Open in Browser', url: webAppUrl }]
          ]
        }
      });
    } else {
      await ctx.reply(messageText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '♟️ Open Chess Board', web_app: { url: webAppUrl } }
          ]]
        }
      });
    }
  } catch (err) {
    console.error('newgame error:', err);
    await ctx.reply('⚠️ Could not create game. Check server logs.');
  }
});

bot.start(async (ctx) => {
  await ctx.reply(
    `♟️ *Chess Bot*\n\nUse /newgame to start a game.\nOr type @${BOT_USERNAME || 'me'} in any group to send an invite!`,
    { parse_mode: 'Markdown' }
  );
});

// ========== START ==========
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await fetchBotInfo(); // ensure username is loaded before accepting inline queries
  bot.launch()
    .then(() => console.log('✅ Bot online!'))
    .catch((err) => console.error('❌ Bot error:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
