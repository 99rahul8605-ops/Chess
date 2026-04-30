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
    // Fetch bot username
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok) {
      BOT_USERNAME = data.result.username;
      console.log(`✅ Bot username: @${BOT_USERNAME}`);
    } else {
      console.error('❌ getMe failed:', data.description);
    }

    // Auto-update the menu button Web App URL from BASE_URL env
    const webAppUrl = `${BASE_URL}/`;
    const menuRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: '♟️ Play Chess',
          web_app: { url: webAppUrl }
        }
      })
    });
    const menuData = await menuRes.json();
    if (menuData.ok) {
      console.log(`✅ Menu button URL auto-set to: ${webAppUrl}`);
    } else {
      console.warn('⚠️ Could not set menu button:', menuData.description);
    }
  } catch (err) {
    console.error('❌ Could not fetch bot info:', err.message);
  }
}

// ========== MINI APP SHORT NAME ==========
function extractShortName(value) {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || null;
}
const APP_SHORT_NAME = extractShortName(process.env.MINI_APP_SHORT_NAME);
if (APP_SHORT_NAME) {
  console.log(`🎮 Mini App short name: ${APP_SHORT_NAME}`);
} else {
  console.warn('⚠️  MINI_APP_SHORT_NAME is not set — Play Chess button will use BASE_URL fallback.');
}

function getMiniAppLink(gameId) {
  // Prefer the Telegram Mini App deep link when both BOT_USERNAME and APP_SHORT_NAME are available.
  // Fall back to the plain BASE_URL web link so the button always works.
  if (BOT_USERNAME && APP_SHORT_NAME) {
    return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=${gameId}`;
  }
  console.warn(`⚠️  getMiniAppLink fallback used for game ${gameId} — BOT_USERNAME=${BOT_USERNAME}, APP_SHORT_NAME=${APP_SHORT_NAME}`);
  return getGameUrl(gameId);
}

function getGameUrl(gameId) {
  return `${BASE_URL}/?game=${gameId}`;
}

// ========== BOT MESSAGE HELPERS ==========
function escMd(str) {
  // Escape all MarkdownV2 special characters
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function buildGameMessage(game, gameId, timeLabel) {
  const miniAppLink = getMiniAppLink(gameId);
  const hasWhite = !!(game.whiteUserId);
  const hasBlack = !!(game.blackUserId);
  const whiteName = escMd(game.whitePlayerInfo?.firstName || 'Player 1');
  const blackName = escMd(game.blackPlayerInfo?.firstName || 'Player 2');
  const timeLabelE = escMd(timeLabel);
  const gameIdE = escMd(gameId);

  let statusLines = '';
  let buttonText = '♟️ Play Chess';

  if (game.gameOverByTime || (game.chess && chessCompat(game.chess).isGameOver()) || game.isDraw) {
    const c = chessCompat(game.chess);
    let resultLine = '';
    if (game.isDraw) {
      resultLine = '🤝 *Result: Draw by agreement*';
    } else if (game.resignedBy) {
      const winner = game.resignedBy === 'white' ? blackName : whiteName;
      const loser = game.resignedBy === 'white' ? whiteName : blackName;
      resultLine = `🏆 *${winner} wins\\!* — ${loser} resigned 🏳️`;
    } else {
      const turn = c.turn();
      const checkmate = c.isCheckmate();
      const timeout = game.whiteTime <= 0 || game.blackTime <= 0;
      if (checkmate) {
        const winner = turn === 'w' ? blackName : whiteName;
        resultLine = `🏆 *${winner} wins by checkmate\\!*`;
      } else if (timeout) {
        const winner = game.whiteTime <= 0 ? blackName : whiteName;
        resultLine = `⏰ *${winner} wins on time\\!*`;
      } else if (c.isStalemate()) {
        resultLine = '⚖️ *Stalemate — draw\\!*';
      } else {
        resultLine = '🏁 *Game over*';
      }
    }
    statusLines = `\n⚪ ${whiteName}  vs  ⚫ ${blackName}\n\n${resultLine}`;
    buttonText = '👁️ View Game';
  } else if (hasWhite && hasBlack) {
    statusLines = `\n⚪ ${whiteName}  ⚔️  ⚫ ${blackName}\n\n🟢 *Match in progress\\.\\.\\.*`;
    buttonText = '♟️ Spectate';
  } else if (game.pendingPlayers && game.pendingPlayers.length > 0) {
    // One player pending — read their name directly from pendingPlayerInfos (not whitePlayerInfo)
    const firstPendingId = game.pendingPlayers[0];
    const firstPendingInfo = (game.pendingPlayerInfos && game.pendingPlayerInfos[firstPendingId]) || { firstName: 'Player' };
    const joinedName = escMd(firstPendingInfo.firstName || 'Player');
    statusLines = `\n⚔️ *${joinedName} joined* — waiting for opponent\\.\\.\\.`;
    buttonText = '♟️ Join & Play';
  } else {
    statusLines = '\n⚔️ First two to join play\n🎲 Colors assigned randomly';
    buttonText = '♟️ Play Chess';
  }

  const text = `🎮 *Chess · ${timeLabelE}*\n\nGame ID: \`${gameIdE}\`\n${statusLines}\n⏱️ Time: ${timeLabelE} each\n\nTap below to play\\!`;
  const buttonUrl = miniAppLink || getGameUrl(gameId);
  // Always include a callback_data button so Telegram sends callback_query with inline_message_id
  // even in channels where chosen_inline_result may not fire.
  const keyboard = [[
    { text: buttonText, url: buttonUrl },
    { text: '​', callback_data: `game:${gameId}` }
  ]];
  return { text, keyboard };
}

async function editBotMessage(game, gameId, timeLabel) {
  if (!BOT_TOKEN) return;
  try {
    const { text, keyboard } = buildGameMessage(game, gameId, timeLabel);
    const reply_markup = JSON.stringify({ inline_keyboard: keyboard });

    if (game.inlineMessageId) {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inline_message_id: game.inlineMessageId,
          text,
          parse_mode: 'MarkdownV2',
          reply_markup
        })
      });
      const data = await res.json();
      if (!data.ok) {
        console.warn(`⚠️ editBotMessage (inline) failed [${gameId}]: ${data.description}`);
        // If inline edit fails, fall through to chatId/messageId if available
        if (game.chatId && game.botMessageId) {
          const res2 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: game.chatId,
              message_id: game.botMessageId,
              text,
              parse_mode: 'MarkdownV2',
              reply_markup
            })
          });
          const data2 = await res2.json();
          if (!data2.ok) console.warn(`⚠️ editBotMessage (chat fallback) failed [${gameId}]: ${data2.description}`);
        }
      }
    } else if (game.chatId && game.botMessageId) {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: game.chatId,
          message_id: game.botMessageId,
          text,
          parse_mode: 'MarkdownV2',
          reply_markup
        })
      });
      const data = await res.json();
      if (!data.ok) console.warn(`⚠️ editBotMessage (chat) failed [${gameId}]: ${data.description}`);
    } else {
      console.warn(`⚠️ editBotMessage skipped [${gameId}]: no inlineMessageId or chatId/botMessageId stored`);
    }
  } catch (err) {
    console.error('editBotMessage error:', err.message);
  }
}

function getTimeLabel(initialTimeSec) {
  return initialTimeSec <= 300 ? '5 min' : '10 min';
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
    inlineMessageId: null,    // Telegram inline_message_id for live edits
    chatId: null,             // for /newgame command messages
    botMessageId: null,       // for /newgame command messages
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

  // Resign takes priority over everything
  if (game.resignedBy) {
    winner = game.resignedBy === 'white' ? 'black' : 'white';
  } else {
    // Timeout takes priority over draw
    const timeOutResult = checkTimeOut(game);
    if (timeOutResult) {
      winner = timeOutResult.winner;
    } else if (winner) {
      // explicit winner passed in, use as-is
    } else if (game.isDraw) {
      isDraw = true;
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
      // Notify Telegram message on timeout
      editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});
    }
    if (liveBlackTime <= 0 && !game.gameOverByTime) {
      game.gameOverByTime = true; game.blackTime = 0; liveBlackTime = 0;
      // Notify Telegram message on timeout
      editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});
    }
    gameOver = c.isGameOver() || game.gameOverByTime;
  }

  const timeOutResult = game.resignedBy ? null : checkTimeOut(game);
  if (timeOutResult) {
    gameOver = true;
    winner = timeOutResult.winner;
    draw = false;
    stalemate = false;
  } else if (game.resignedBy) {
    gameOver = true;
    winner = game.resignedBy === 'white' ? 'black' : 'white';
  } else if (checkmate) {
    winner = turn === 'w' ? 'black' : 'white';
  }

  // Determine reason for game over
  let reason = null;
  if (gameOver) {
    if (game.resignedBy) reason = 'resign';
    else if (timeOutResult) reason = 'timeout';
    else if (checkmate) reason = 'checkmate';
    else if (stalemate) reason = 'stalemate';
    else if (game.isDraw) reason = 'draw';
    else if (draw) reason = 'draw';
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
    reason,
    resignedBy: game.resignedBy || null,
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

  // Always cache the joining player's info so the message shows their real name
  if (!game.pendingPlayerInfos) game.pendingPlayerInfos = {};
  const resolvedInfo = userInfo || viewers.get(userId)?.userInfo;
  if (resolvedInfo) game.pendingPlayerInfos[userId] = resolvedInfo;

  if (game.pendingPlayers.length >= 2) {
    // 2nd player joined — give them the remaining color
    const [playerA, playerB] = game.pendingPlayers;
    const playerAColor = game.assignedPlayers.get(playerA); // already assigned on 1st join
    const playerBColor = playerAColor === 'white' ? 'black' : 'white';

    game.assignedPlayers.set(playerB, playerBColor);
    game.whiteUserId = playerAColor === 'white' ? playerA : playerB;
    game.blackUserId = playerAColor === 'black' ? playerA : playerB;

    game.whitePlayerInfo = game.pendingPlayerInfos[game.whiteUserId] || { firstName: 'White' };
    game.blackPlayerInfo = game.pendingPlayerInfos[game.blackUserId] || { firstName: 'Black' };

    game.pendingPlayers = [];
    game.lastMoveTimestamp = Date.now();

    editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});

    const color = game.assignedPlayers.get(userId);
    return res.json({ color, ...buildStateResponse(game, gameId) });
  }

  // 1st player joined — assign their color randomly right now
  const firstColor = Math.random() < 0.5 ? 'white' : 'black';
  game.assignedPlayers.set(userId, firstColor);

  editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});

  res.json({
    color: firstColor,
    waitingForAssignment: false,
    waitingForOpponent: true,
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
      editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});
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
  game.resignedBy = playerColor;
  const winner = playerColor === 'white' ? 'black' : 'white';
  
  await recordGameResult(game, winner);
  editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});

  const state = buildStateResponse(game, gameId);
  res.json({
    success: true,
    ...state,
    winner,           // ensure resign winner is never overwritten by buildStateResponse
    reason: 'resign',
    resignedBy: playerColor,
    isGameOver: true,
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

  editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});
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
          { text: '♟️ Play Chess', url: miniAppLink5 },
          { text: '​', callback_data: `game:${gameId5}` }
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
          { text: '♟️ Play Chess', url: miniAppLink10 },
          { text: '​', callback_data: `game:${gameId10}` }
        ]]
      }
    }
  ], { cache_time: 0 });
});

// NOTE: For chosen_inline_result to fire, enable inline feedback in BotFather:
// /setinlinefeedback → select your bot → enable (100%)
// Without this, inlineMessageId will never be saved.
// When user picks an inline result, Telegram fires chosen_inline_result with inline_message_id
bot.on('chosen_inline_result', (ctx) => {
  const { result_id, inline_message_id } = ctx.chosenInlineResult;
  const game = games.get(result_id);
  if (game && inline_message_id) {
    game.inlineMessageId = inline_message_id;
    console.log(`📌 Saved inlineMessageId via chosen_inline_result for game ${result_id}: ${inline_message_id}`);
  }
});

// Fallback: capture inline_message_id from callback_query when the button is tapped
// This works even without BotFather inline feedback enabled.
// We use a lightweight callback button alongside the URL button for inline messages.
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const inlineMessageId = ctx.callbackQuery.inline_message_id;
  if (data?.startsWith('game:') && inlineMessageId) {
    const gameId = data.replace('game:', '');
    const game = games.get(gameId);
    if (game && !game.inlineMessageId) {
      game.inlineMessageId = inlineMessageId;
      console.log(`📌 Saved inlineMessageId via callback_query for game ${gameId}: ${inlineMessageId}`);
      // Re-edit the message now that we have the ID
      editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  }
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
      const sentMsg = await ctx.reply(messageTextOut, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '♟️ Play Chess', url: miniAppLink }]
          ]
        }
      });
      const game = games.get(gameId);
      if (game && sentMsg) {
        game.chatId = sentMsg.chat.id;
        game.botMessageId = sentMsg.message_id;
      }
    } else {
      const sentMsg = await ctx.reply(messageTextOut, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '♟️ Play Now', web_app: { url: webAppUrl } }],
            [{ text: '🔗 Game Link', url: miniAppLink }]
          ]
        }
      });
      const game = games.get(gameId);
      if (game && sentMsg) {
        game.chatId = sentMsg.chat.id;
        game.botMessageId = sentMsg.message_id;
      }
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