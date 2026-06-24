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

// ========== AUTO BOT SETUP ON DEPLOYMENT ==========
let BOT_USERNAME = null;

/**
 * Telegram Bot API helper — POST request
 */
async function tgPost(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

/**
 * setupBot() — called once on server start.
 * Automatically configures everything that was previously done manually:
 *   1. Fetch & store bot username
 *   2. Set / clear webhook depending on USE_WEBHOOK env
 *   3. Register bot commands (visible in Telegram command menu)
 *   4. Set menu button → Web App URL
 *   5. Set bot description & short description
 */
async function setupBot() {
  console.log('\n🤖 ── Bot Auto-Setup Starting ──────────────────');

  // ── 1. GET BOT INFO ──────────────────────────────
  try {
    const data = await tgPost('getMe', {});
    if (data.ok) {
      BOT_USERNAME = data.result.username;
      console.log(`  ✅ Bot username   : @${BOT_USERNAME}`);
      console.log(`  ℹ️  Bot name       : ${data.result.first_name}`);
      console.log(`  ℹ️  Inline queries : ${data.result.supports_inline_queries ? 'enabled' : 'disabled'}`);
    } else {
      console.error('  ❌ getMe failed:', data.description);
    }
  } catch (err) {
    console.error('  ❌ getMe error:', err.message);
  }

  // ── 2. WEBHOOK vs POLLING ────────────────────────
  const useWebhook = process.env.USE_WEBHOOK === 'true';
  if (useWebhook) {
    const webhookUrl = `${BASE_URL}/bot${BOT_TOKEN}`;
    try {
      const data = await tgPost('setWebhook', {
        url: webhookUrl,
        allowed_updates: ['message', 'inline_query', 'chosen_inline_result', 'callback_query'],
        drop_pending_updates: true
      });
      if (data.ok) {
        console.log(`  ✅ Webhook set    : ${webhookUrl}`);
      } else {
        console.warn('  ⚠️  setWebhook failed:', data.description);
      }
    } catch (err) {
      console.error('  ❌ setWebhook error:', err.message);
    }
  } else {
    // Polling mode — make sure no stale webhook is blocking updates
    try {
      const data = await tgPost('deleteWebhook', { drop_pending_updates: false });
      if (data.ok) {
        console.log('  ✅ Webhook cleared (polling mode)');
      }
    } catch (err) {
      console.warn('  ⚠️  deleteWebhook error:', err.message);
    }
  }

  // ── 3. BOT COMMANDS ──────────────────────────────
  try {
    const commands = [
      { command: 'start',   description: 'Start the bot & get game invite button' },
      { command: 'newgame', description: 'Create a new chess game (use: /newgame 5 or /newgame 10)' }
    ];
    // Set commands for private chats
    const privateData = await tgPost('setMyCommands', {
      commands,
      scope: { type: 'all_private_chats' }
    });
    // Set commands for group chats
    const groupData = await tgPost('setMyCommands', {
      commands,
      scope: { type: 'all_group_chats' }
    });
    if (privateData.ok && groupData.ok) {
      console.log(`  ✅ Commands set   : /${commands.map(c => c.command).join(', /')}`);
    } else {
      console.warn('  ⚠️  setMyCommands failed:', privateData.description || groupData.description);
    }
  } catch (err) {
    console.error('  ❌ setMyCommands error:', err.message);
  }

  // ── 4. MENU BUTTON → WEB APP ─────────────────────
  const webAppUrl = `${BASE_URL}/`;
  try {
    const data = await tgPost('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: '♟️ Play Chess',
        web_app: { url: webAppUrl }
      }
    });
    if (data.ok) {
      console.log(`  ✅ Menu button    : ${webAppUrl}`);
    } else {
      console.warn('  ⚠️  setChatMenuButton failed:', data.description);
    }
  } catch (err) {
    console.error('  ❌ setChatMenuButton error:', err.message);
  }

  // ── 5. BOT DESCRIPTION ───────────────────────────
  const description = process.env.BOT_DESCRIPTION ||
    'Play chess directly inside Telegram! Challenge friends or anyone in a group. ' +
    'Use /newgame to start a game, or tap the menu button to open the Chess Mini App.';
  const shortDescription = process.env.BOT_SHORT_DESCRIPTION ||
    'Play chess with friends inside Telegram ♟️';
  try {
    const [descData, shortData] = await Promise.all([
      tgPost('setMyDescription',      { description }),
      tgPost('setMyShortDescription', { short_description: shortDescription })
    ]);
    if (descData.ok)  console.log('  ✅ Description    : set');
    else              console.warn('  ⚠️  setMyDescription failed:', descData.description);
    if (shortData.ok) console.log('  ✅ Short desc     : set');
    else              console.warn('  ⚠️  setMyShortDescription failed:', shortData.description);
  } catch (err) {
    console.error('  ❌ setMyDescription error:', err.message);
  }

  // ── 6. UPDATE MINI APP URL ───────────────────────
  // editMyApp updates the Mini App's registered URL in BotFather automatically.
  // This fixes the "old URL in inline Play button" problem after redeployment.
  if (APP_SHORT_NAME) {
    try {
      const data = await tgPost('editMyApp', {
        short_name: APP_SHORT_NAME,
        url: `${BASE_URL}/`
      });
      if (data.ok) {
        console.log(`  ✅ Mini App URL   : ${BASE_URL}/ (short_name: ${APP_SHORT_NAME})`);
      } else {
        console.warn(`  ⚠️  editMyApp failed: ${data.description}`);
        console.warn(`      → Update Mini App URL manually in BotFather: /myapps → ${APP_SHORT_NAME} → Edit URL → ${BASE_URL}/`);
      }
    } catch (err) {
      console.error('  ❌ editMyApp error:', err.message);
    }
  } else {
    console.warn('  ⚠️  Skipping editMyApp — MINI_APP_SHORT_NAME not set in .env');
  }

  console.log('🤖 ── Bot Auto-Setup Complete ───────────────────\n');
}

// Keep backward-compatible alias so nothing else breaks
const fetchBotInfo = setupBot;

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
    return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?mode=fullscreen&startapp=${gameId}`;
  }
  console.warn(`⚠️  getMiniAppLink fallback used for game ${gameId} — BOT_USERNAME=${BOT_USERNAME}, APP_SHORT_NAME=${APP_SHORT_NAME}`);
  return getGameUrl(gameId);
}

function getGameUrl(gameId) {
  // Use path-based URL (/join/:gameId) instead of query params.
  // Telegram can cache the root URL and strip ?game= params when reopening a
  // Mini App that is already open — path segments are always preserved.
  return `${BASE_URL}/join/${gameId}`;
}

// Serve index.html for every /join/:gameId deep-link so the path survives
// even when the HTML is loaded fresh (express static only handles /).
app.get('/join/:gameId', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

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
    { text: '🔄 Refresh', callback_data: `game:${gameId}` }
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
      recordGameResult(game, 'black').catch(() => {}); // black wins on time
      editBotMessage(game, gameId, getTimeLabel(game.initialTime)).catch(() => {});
    }
    if (liveBlackTime <= 0 && !game.gameOverByTime) {
      game.gameOverByTime = true; game.blackTime = 0; liveBlackTime = 0;
      recordGameResult(game, 'white').catch(() => {}); // white wins on time
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
        return res.json({ stats: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0 }, profile: {} });
      }
      return res.json({
        stats: user.stats,
        profile: {
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          username: user.username || '',
          photoUrl: user.photoUrl || ''
        }
      });
    } else {
      const entry = memoryStats.get(req.params.userId);
      if (!entry) {
        return res.json({ stats: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0 }, profile: {} });
      }
      return res.json({
        stats: entry.stats,
        profile: {
          firstName: entry.firstName || '',
          lastName: entry.lastName || '',
          username: entry.username || '',
          photoUrl: entry.photoUrl || ''
        }
      });
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

// ========== PLAY REQUESTS ==========
// Map: userId -> { userId, userInfo, createdAt, timeControl }
const playRequests = new Map();
const PLAY_REQUEST_TTL = 10 * 60 * 1000; // 10 minutes

// POST /api/play-request — send / refresh a play request
app.post('/api/play-request', (req, res) => {
  const { userId, userInfo, timeControl } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  playRequests.set(userId, {
    userId,
    userInfo: userInfo || { firstName: 'Anonymous' },
    timeControl: timeControl || 10,
    createdAt: Date.now()
  });
  res.json({ success: true });
});

// DELETE /api/play-request/:userId — remove own request
app.delete('/api/play-request/:userId', (req, res) => {
  playRequests.delete(req.params.userId);
  res.json({ success: true });
});

// GET /api/play-requests — list active requests (excluding expired)
app.get('/api/play-requests', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [uid, req2] of playRequests.entries()) {
    if (now - req2.createdAt < PLAY_REQUEST_TTL) {
      list.push(req2);
    } else {
      playRequests.delete(uid);
    }
  }
  res.json({ requests: list });
});

// POST /api/play-request/accept — accept someone's request → create game & pre-assign both players
app.post('/api/play-request/accept', (req, res) => {
  const { acceptorId, acceptorInfo, requesterId, timeControl } = req.body;
  if (!acceptorId || !requesterId) return res.status(400).json({ error: 'acceptorId and requesterId required' });

  // Grab requester's userInfo from stored request
  const requesterReq = playRequests.get(requesterId);
  const requesterInfo = requesterReq?.userInfo || { firstName: 'Player' };

  // Remove both users' requests
  playRequests.delete(acceptorId);
  playRequests.delete(requesterId);

  const tc = (timeControl === 5 || timeControl === '5') ? TIME_5_MIN : DEFAULT_TIME_SEC;
  const gameId = createNewGame(tc);
  const game = games.get(gameId);

  // Randomly assign colors
  const acceptorColor = Math.random() < 0.5 ? 'white' : 'black';
  const requesterColor = acceptorColor === 'white' ? 'black' : 'white';

  // Assign both players
  game.assignedPlayers.set(acceptorId, acceptorColor);
  game.assignedPlayers.set(requesterId, requesterColor);

  game.whiteUserId  = acceptorColor === 'white' ? acceptorId  : requesterId;
  game.blackUserId  = acceptorColor === 'black' ? acceptorId  : requesterId;

  const aInfo = acceptorInfo || { firstName: 'Player' };
  game.whitePlayerInfo = game.whiteUserId === acceptorId ? aInfo : requesterInfo;
  game.blackPlayerInfo = game.blackUserId === acceptorId ? aInfo : requesterInfo;

  // Init pending so join endpoint also recognises them
  game.pendingPlayerInfos = {
    [acceptorId]:  aInfo,
    [requesterId]: requesterInfo
  };

  game.lastMoveTimestamp = Date.now();

  // Add both to activeViewers
  activeViewers.get(gameId).set(acceptorId,  { lastSeen: Date.now(), userInfo: aInfo });
  activeViewers.get(gameId).set(requesterId, { lastSeen: Date.now(), userInfo: requesterInfo });

  res.json({ success: true, gameId, url: getGameUrl(gameId), acceptorColor, requesterColor });
});

// ========== PUBLIC GAMES ==========
// GET /api/my-active-game/:userId — find live game where this user is a player
app.get('/api/my-active-game/:userId', (req, res) => {
  const uid = req.params.userId;
  for (const [gameId, game] of games.entries()) {
    const c = chessCompat(game.chess);
    const isPlayer = game.whiteUserId === uid || game.blackUserId === uid;
    const isLive   = game.whiteUserId && game.blackUserId && !c.isGameOver() && !game.gameOverByTime;
    if (isPlayer && isLive) {
      return res.json({ gameId, url: getGameUrl(gameId) });
    }
  }
  res.json({ gameId: null });
});

// GET /api/public-games — list all live (in-progress) games
app.get('/api/public-games', (req, res) => {
  const list = [];
  for (const [gameId, game] of games.entries()) {
    const c = chessCompat(game.chess);
    const isLive = game.whiteUserId && game.blackUserId &&
                   !c.isGameOver() && !game.gameOverByTime;
    if (isLive) {
      list.push({
        gameId,
        whitePlayer: game.whitePlayerInfo,
        blackPlayer: game.blackPlayerInfo,
        whiteUserId: game.whiteUserId,
        blackUserId: game.blackUserId,
        timeLabel: getTimeLabel(game.initialTime),
        whiteTime: game.whiteTime,
        blackTime: game.blackTime,
        createdAt: game.createdAt,
        moveCount: game.chess.history ? game.chess.history().length : 0
      });
    }
  }
  res.json({ games: list });
});

// ========== CLEANUP ==========
setInterval(() => {
  const now = Date.now();

  // Cleanup stale play requests
  for (const [uid, req2] of playRequests.entries()) {
    if (now - req2.createdAt >= PLAY_REQUEST_TTL) {
      playRequests.delete(uid);
    }
  }

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
          { text: '🔄 Refresh', callback_data: `game:${gameId5}` }
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
          { text: '🔄 Refresh', callback_data: `game:${gameId10}` }
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

  const keyboard = [
    [{
      text: '📤 Send Game Invite',
      switch_inline_query: ''
    }]
  ];

  const supportChannel = process.env.SUPPORT_CHANNEL;
  if (supportChannel) {
    keyboard.push([{
      text: '📢 Support Channel',
      url: supportChannel
    }]);
  }

  await ctx.reply(inviteMessage, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
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