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
// v0.x: chess.game_over(), chess.in_checkmate(), chess.in_stalemate(), chess.in_draw(), chess.in_check()
// v1.x: chess.isGameOver(), chess.isCheckmate(), chess.isStalemate(), chess.isDraw(), chess.inCheck()
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
  return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${gameId}`;
}

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
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
    lastMove: null,
    createdAt: Date.now()
  });
  return gameId;
}

function buildStateResponse(game) {
  const c = chessCompat(game.chess);
  const gameOver  = c.isGameOver();
  const checkmate = c.isCheckmate();
  const stalemate = c.isStalemate();
  const draw      = c.isDraw();
  const inCheck   = c.inCheck();
  const turn      = c.turn();

  return {
    fen:               c.fen(),
    turn,
    lastMove:          game.lastMove,
    waitingForOpponent: !(game.whiteUserId && game.blackUserId),
    isGameOver:        gameOver,
    isCheckmate:       checkmate,
    isStalemate:       stalemate,
    isDraw:            draw,
    inCheck,
    winner: checkmate ? (turn === 'w' ? 'black' : 'white') : null
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

  try {
    const result = c.move({ from, to, promotion: promotion || 'q' });
    if (!result) return res.status(400).json({ error: 'Invalid move' });
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
  const gameId = createNewGame();
  await ctx.answerInlineQuery([
    {
      type: 'article',
      id: gameId,
      title: '♟️ Start a Chess Game',
      description: 'Send a chess game invite to this chat',
      thumbnail_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Chess_kdt45.svg/45px-Chess_kdt45.svg.png',
      input_message_content: {
        message_text: `🎮 *Chess Game Challenge!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black\n\nTap below to play!`,
        parse_mode: 'Markdown'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '♟️ Play Chess', url: getMiniAppLink(gameId) }
        ]]
      }
    }
  ], { cache_time: 0 });
});

bot.command('newgame', async (ctx) => {
  try {
    const gameId = createNewGame();
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    if (isGroup) {
      await ctx.reply(
        `🎮 *New Chess Game!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '♟️ Play Chess (Mini App)', url: getMiniAppLink(gameId) }],
              [{ text: '🌐 Open in Browser', url: getGameUrl(gameId) }]
            ]
          }
        }
      );
    } else {
      await ctx.reply(
        `🎮 *New Chess Game!*\n\nGame ID: \`${gameId}\`\n\n♔ 1st to join = White\n♚ 2nd to join = Black`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '♟️ Open Chess Board', web_app: { url: getGameUrl(gameId) } }
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

bot.start(async (ctx) => {
  await ctx.reply(
    `♟️ *Chess Bot*\n\nUse /newgame to start a game.\nOr type @${BOT_USERNAME || 'me'} in any group to send an invite!`,
    { parse_mode: 'Markdown' }
  );
});

// ========== START ==========
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await fetchBotInfo();
  bot.launch()
    .then(() => console.log('✅ Bot online!'))
    .catch((err) => console.error('❌ Bot error:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
