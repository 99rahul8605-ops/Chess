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
    if (whiteId && blackId) {
      if (!recentOpponents.has(whiteId)) recentOpponents.set(whiteId, new Map());
      if (!recentOpponents.has(blackId)) recentOpponents.set(blackId, new Map());
      recentOpponents.get(whiteId).set(blackId, { userInfo: blackInfo, lastPlayedAt: Date.now() });
      recentOpponents.get(blackId).set(whiteId, { userInfo: whiteInfo, lastPlayedAt: Date.now() });
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

  // If exactly one player has joined so far and we already know who we're waiting on
  // (e.g. a friend challenge), surface their name so the waiting screen can say who for.
  let pendingOpponentName = null;
  if (!(game.whiteUserId && game.blackUserId) && game.pendingPlayers.length === 1 && game.pendingPlayerInfos) {
    const joinedId = game.pendingPlayers[0];
    const otherId = Object.keys(game.pendingPlayerInfos).find(id => id !== joinedId);
    if (otherId) pendingOpponentName = game.pendingPlayerInfos[otherId]?.firstName || null;
  }

  return {
    fen: c.fen(),
    turn,
    lastMove: game.lastMove,
    waitingForOpponent: !(game.whiteUserId && game.blackUserId),
    waitingForAssignment: game.pendingPlayers.length > 0,
    pendingOpponentName,
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
  const { userId, reason } = req.body;
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

  const finalReason = (reason === 'exit') ? 'exit' : 'resign';

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
    reason: finalReason,
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

// Map: userId -> gameId  (cleared once fetched)
const pendingGameNotifications = new Map();

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

  game.pendingPlayerInfos = {
    [acceptorId]:  aInfo,
    [requesterId]: requesterInfo
  };

  game.lastMoveTimestamp = Date.now();

  activeViewers.get(gameId).set(acceptorId,  { lastSeen: Date.now(), userInfo: aInfo });
  activeViewers.get(gameId).set(requesterId, { lastSeen: Date.now(), userInfo: requesterInfo });

  // Notify requester so their page auto-redirects
  pendingGameNotifications.set(String(requesterId), gameId);

  res.json({ success: true, gameId, url: getGameUrl(gameId), acceptorColor, requesterColor });
});

// GET /api/game-notify/:userId — requester polls this; returns gameId once then clears
app.get('/api/game-notify/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const gameId = pendingGameNotifications.get(uid);
  if (gameId) {
    pendingGameNotifications.delete(uid); // one-shot
    return res.json({ gameId });
  }
  res.json({ gameId: null });
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

// ========== QUICK MATCHMAKING ==========
const matchQueue = new Map();      // userId -> { userId, userInfo, timeControl, joinedAt }
const matchResults = new Map();    // userId -> gameId (one-shot notification for the player who was already waiting)
const MATCH_QUEUE_TTL = 2 * 60 * 1000; // 2 minutes

// POST /api/matchmaking/join — join the quick-match queue, or get paired instantly if someone's already waiting
app.post('/api/matchmaking/join', (req, res) => {
  const { userId, userInfo, timeControl } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const uid = String(userId);

  // Already matched from a previous call (e.g. duplicate click)?
  if (matchResults.has(uid)) {
    const gameId = matchResults.get(uid);
    matchResults.delete(uid);
    return res.json({ gameId });
  }

  // Clean expired queue entries first
  const now = Date.now();
  for (const [qid, entry] of matchQueue.entries()) {
    if (now - entry.joinedAt >= MATCH_QUEUE_TTL) matchQueue.delete(qid);
  }

  // Look for someone else already waiting — prefer a same time-control match first
  const myTC = (timeControl === 5) ? 5 : 10;
  let opponent = null;
  for (const [qid, entry] of matchQueue.entries()) {
    if (qid !== uid && entry.timeControl === myTC) { opponent = entry; break; }
  }
  if (!opponent) {
    for (const [qid, entry] of matchQueue.entries()) {
      if (qid !== uid) { opponent = entry; break; }
    }
  }

  if (opponent) {
    matchQueue.delete(opponent.userId);
    matchQueue.delete(uid);

    const tc = (myTC === 5) ? TIME_5_MIN : DEFAULT_TIME_SEC;
    const gameId = createNewGame(tc);
    const game = games.get(gameId);

    const joinerColor   = Math.random() < 0.5 ? 'white' : 'black';
    const opponentColor = joinerColor === 'white' ? 'black' : 'white';

    game.assignedPlayers.set(uid, joinerColor);
    game.assignedPlayers.set(opponent.userId, opponentColor);

    game.whiteUserId = joinerColor === 'white' ? uid : opponent.userId;
    game.blackUserId = joinerColor === 'black' ? uid : opponent.userId;

    const myInfo = userInfo || { firstName: 'Player' };
    game.whitePlayerInfo = game.whiteUserId === uid ? myInfo : opponent.userInfo;
    game.blackPlayerInfo = game.blackUserId === uid ? myInfo : opponent.userInfo;

    game.pendingPlayerInfos = {
      [uid]: myInfo,
      [opponent.userId]: opponent.userInfo
    };
    game.lastMoveTimestamp = Date.now();

    activeViewers.get(gameId).set(uid, { lastSeen: now, userInfo: myInfo });
    activeViewers.get(gameId).set(opponent.userId, { lastSeen: now, userInfo: opponent.userInfo });

    // Notify the other player (who's polling status) so their page redirects too
    matchResults.set(opponent.userId, gameId);

    return res.json({ gameId });
  }

  // No one waiting — join the queue ourselves
  matchQueue.set(uid, {
    userId: uid,
    userInfo: userInfo || { firstName: 'Anonymous' },
    timeControl: timeControl || 10,
    joinedAt: now
  });
  res.json({ waiting: true });
});

// GET /api/matchmaking/status/:userId — poll while waiting; returns gameId once matched
app.get('/api/matchmaking/status/:userId', (req, res) => {
  const uid = String(req.params.userId);
  if (matchResults.has(uid)) {
    const gameId = matchResults.get(uid);
    matchResults.delete(uid);
    return res.json({ gameId });
  }
  res.json({ gameId: null, waiting: matchQueue.has(uid) });
});

// DELETE /api/matchmaking/:userId — cancel search
app.delete('/api/matchmaking/:userId', (req, res) => {
  matchQueue.delete(String(req.params.userId));
  res.json({ success: true });
});

// ========== FRIENDS ==========

// POST /api/friend-request/send — direct request (used by the in-game "+ Add Friend" icon,
// where both userIds are already known — no deep link needed).
app.post('/api/friend-request/send', (req, res) => {
  const { userId, userInfo, targetUserId } = req.body;
  if (!userId || !targetUserId) return res.status(400).json({ error: 'userId and targetUserId required' });
  const uid = String(userId), tid = String(targetUserId);
  if (uid === tid) return res.status(400).json({ error: 'Cannot friend yourself' });
  if (friends.get(uid)?.has(tid)) return res.status(400).json({ error: 'Already friends' });

  // If they already sent ME a request, just accept it instead of creating a duplicate reverse request
  const theirRequestToMe = friendRequests.get(uid)?.get(tid);
  if (theirRequestToMe) {
    friendRequests.get(uid).delete(tid);
    if (!friends.has(uid)) friends.set(uid, new Map());
    if (!friends.has(tid)) friends.set(tid, new Map());
    friends.get(uid).set(tid, theirRequestToMe.userInfo);
    friends.get(tid).set(uid, userInfo || { firstName: 'Player' });
    return res.json({ success: true, autoAccepted: true });
  }

  if (friendRequests.get(tid)?.has(uid)) {
    return res.json({ success: true, alreadySent: true }); // don't duplicate
  }

  if (!friendRequests.has(tid)) friendRequests.set(tid, new Map());
  friendRequests.get(tid).set(uid, { userInfo: userInfo || { firstName: 'Player' }, createdAt: Date.now() });

  // Best-effort bot DM so they get notified even if they don't have the app open
  const theirChatId = userChatIds.get(tid) || tid;
  if (theirChatId) {
    bot.telegram.sendMessage(
      theirChatId,
      `🤝 *${(userInfo && userInfo.firstName) || 'Someone'}* sent you a friend request!\n\nOpen the app to accept.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '♟️ Open Chess', web_app: { url: `${BASE_URL}/` } }]] } }
    ).catch(err => console.warn('Could not DM friend-request recipient:', err.message));
  }

  res.json({ success: true });
});

// GET /api/friend-status/:userId/:targetId — used to decide what the in-game "+" icon should show
app.get('/api/friend-status/:userId/:targetId', (req, res) => {
  const uid = String(req.params.userId), tid = String(req.params.targetId);
  res.json({
    isFriend:        !!(friends.get(uid)?.has(tid)),
    requestSentByMe: !!(friendRequests.get(tid)?.has(uid)),
    requestFromThem: !!(friendRequests.get(uid)?.has(tid))
  });
});

// GET /api/friend-suggestions/:userId — people you've played before who aren't friends yet
app.get('/api/friend-suggestions/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const opponents = recentOpponents.get(uid);
  if (!opponents) return res.json({ suggestions: [] });

  const myFriends           = friends.get(uid) || new Map();
  const myIncomingRequests  = friendRequests.get(uid) || new Map();

  const suggestions = [];
  for (const [oppId, entry] of opponents.entries()) {
    if (myFriends.has(oppId)) continue;
    if (myIncomingRequests.has(oppId)) continue; // already pending in the requests list, don't duplicate
    suggestions.push({
      userId: oppId,
      userInfo: entry.userInfo,
      lastPlayedAt: entry.lastPlayedAt,
      requestSent: !!(friendRequests.get(oppId)?.has(uid))
    });
  }
  suggestions.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
  res.json({ suggestions: suggestions.slice(0, 10) });
});

// GET /api/bot-username — so the client can build a shareable friend deep-link
app.get('/api/bot-username', (req, res) => {
  res.json({ username: BOT_USERNAME || '' });
});

// GET /api/friend-requests/:userId — incoming pending requests for this user
app.get('/api/friend-requests/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const now = Date.now();
  const incoming = friendRequests.get(uid);
  if (!incoming) return res.json({ requests: [] });

  const requests = [];
  for (const [fromUserId, entry] of incoming.entries()) {
    if (now - entry.createdAt >= FRIEND_REQUEST_TTL) { incoming.delete(fromUserId); continue; }
    requests.push({ fromUserId, userInfo: entry.userInfo, createdAt: entry.createdAt });
  }
  res.json({ requests });
});

// POST /api/friend-request/accept — { userId, requesterId }
app.post('/api/friend-request/accept', (req, res) => {
  const { userId, requesterId } = req.body;
  if (!userId || !requesterId) return res.status(400).json({ error: 'userId and requesterId required' });
  const uid = String(userId), rid = String(requesterId);

  const incoming = friendRequests.get(uid);
  const entry = incoming?.get(rid);
  if (!entry) return res.status(404).json({ error: 'Friend request not found' });

  incoming.delete(rid);

  if (!friends.has(uid)) friends.set(uid, new Map());
  if (!friends.has(rid)) friends.set(rid, new Map());
  friends.get(uid).set(rid, entry.userInfo);
  // We don't have `uid`'s userInfo stored on this request; the client sends its own info along.
  const myInfo = req.body.userInfo || { firstName: 'Player' };
  friends.get(rid).set(uid, myInfo);

  res.json({ success: true });
});

// POST /api/friend-request/decline — { userId, requesterId }
app.post('/api/friend-request/decline', (req, res) => {
  const { userId, requesterId } = req.body;
  if (!userId || !requesterId) return res.status(400).json({ error: 'userId and requesterId required' });
  friendRequests.get(String(userId))?.delete(String(requesterId));
  res.json({ success: true });
});

// GET /api/friends/:userId — this user's friend list
app.get('/api/friends/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const list = friends.get(uid);
  if (!list) return res.json({ friends: [] });
  const out = [...list.entries()].map(([friendId, userInfo]) => ({ friendId, userInfo }));
  res.json({ friends: out });
});

// DELETE /api/friends/:userId/:friendId — unfriend (both directions)
app.delete('/api/friends/:userId/:friendId', (req, res) => {
  const uid = String(req.params.userId), fid = String(req.params.friendId);
  friends.get(uid)?.delete(fid);
  friends.get(fid)?.delete(uid);
  res.json({ success: true });
});

// POST /api/friend-challenge — { userId, userInfo, friendId, timeControl }
// Creates a game between the two friends and notifies the friend both in-app and via a bot DM.
// Is this user currently seated as an active PLAYER (not spectator) in an unfinished game?
function isUserInActiveGame(uid) {
  for (const game of games.values()) {
    const color = game.assignedPlayers.get(uid);
    if (color !== 'white' && color !== 'black') continue;
    if (!(game.whiteUserId && game.blackUserId)) continue; // not actually started yet
    const over = game.gameOverByTime || chessCompat(game.chess).isGameOver();
    if (!over) return true;
  }
  return false;
}

// POST /api/friend-challenge — sends a challenge notification only; no game is created
// until the friend explicitly accepts (see /api/friend-challenge/accept below).
app.post('/api/friend-challenge', async (req, res) => {
  const { userId, userInfo, friendId, timeControl } = req.body;
  if (!userId || !friendId) return res.status(400).json({ error: 'userId and friendId required' });
  const uid = String(userId), fid = String(friendId);

  if (!friends.get(uid)?.has(fid)) {
    return res.status(403).json({ error: 'You can only challenge a friend' });
  }

  const myInfo = userInfo || { firstName: 'Player' };
  const tc = (timeControl === 5 || timeControl === '5') ? 5 : 10;

  if (!friendChallenges.has(fid)) friendChallenges.set(fid, new Map());
  friendChallenges.get(fid).set(uid, { userInfo: myInfo, timeControl: tc, createdAt: Date.now() });

  // Best-effort bot DM — opens the app, where the Accept/Decline prompt itself appears
  const friendChatId = userChatIds.get(fid) || fid;
  try {
    await bot.telegram.sendMessage(
      friendChatId,
      `⚔️ *${myInfo.firstName}* challenged you to a game! (${tc} min)\n\nOpen the app to accept or decline.`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '♟️ Open Chess', web_app: { url: `${BASE_URL}/` } }]] }
      }
    );
  } catch (err) {
    console.warn('Could not DM challenged friend:', err.message);
  }

  res.json({ success: true });
});

// GET /api/friend-challenges/:userId — incoming pending challenges for this user
app.get('/api/friend-challenges/:userId', (req, res) => {
  const uid = String(req.params.userId);
  const now = Date.now();
  const incoming = friendChallenges.get(uid);
  if (!incoming) return res.json({ challenges: [] });

  const challenges = [];
  for (const [fromUserId, entry] of incoming.entries()) {
    if (now - entry.createdAt >= FRIEND_CHALLENGE_TTL) { incoming.delete(fromUserId); continue; }
    challenges.push({ fromUserId, userInfo: entry.userInfo, timeControl: entry.timeControl, createdAt: entry.createdAt });
  }
  res.json({ challenges });
});

// POST /api/friend-challenge/accept — { userId, userInfo, challengerId }
app.post('/api/friend-challenge/accept', (req, res) => {
  const { userId, userInfo, challengerId } = req.body;
  if (!userId || !challengerId) return res.status(400).json({ error: 'userId and challengerId required' });
  const uid = String(userId), cid = String(challengerId);

  const incoming = friendChallenges.get(uid);
  const entry = incoming?.get(cid);
  if (!entry) return res.status(404).json({ error: 'Challenge not found or expired' });

  // Actively playing (not just spectating) elsewhere → block accept
  if (isUserInActiveGame(uid)) {
    return res.status(409).json({ error: "You're already in a game — finish it before accepting a new challenge." });
  }

  incoming.delete(cid);

  const tc = entry.timeControl === 5 ? TIME_5_MIN : DEFAULT_TIME_SEC;
  const gameId = createNewGame(tc);
  const game = games.get(gameId);

  const accepterColor   = Math.random() < 0.5 ? 'white' : 'black';
  const challengerColor = accepterColor === 'white' ? 'black' : 'white';

  const myInfo = userInfo || { firstName: 'Player' };
  const challengerInfo = entry.userInfo;

  game.assignedPlayers.set(uid, accepterColor);
  game.assignedPlayers.set(cid, challengerColor);
  game.whiteUserId = accepterColor === 'white' ? uid : cid;
  game.blackUserId = accepterColor === 'black' ? uid : cid;
  game.whitePlayerInfo = game.whiteUserId === uid ? myInfo : challengerInfo;
  game.blackPlayerInfo = game.blackUserId === uid ? myInfo : challengerInfo;
  game.pendingPlayerInfos = { [uid]: myInfo, [cid]: challengerInfo };
  game.lastMoveTimestamp = Date.now();

  activeViewers.get(gameId).set(uid, { lastSeen: Date.now(), userInfo: myInfo });
  activeViewers.get(gameId).set(cid, { lastSeen: Date.now(), userInfo: challengerInfo });

  // Wake up the challenger (who's been waiting) so their client auto-redirects in
  pendingGameNotifications.set(cid, gameId);

  res.json({ success: true, gameId });
});

// POST /api/friend-challenge/decline — { userId, challengerId }
app.post('/api/friend-challenge/decline', (req, res) => {
  const { userId, userInfo, challengerId } = req.body;
  if (!userId || !challengerId) return res.status(400).json({ error: 'userId and challengerId required' });
  const uid = String(userId), cid = String(challengerId);

  const incoming = friendChallenges.get(uid);
  const entry = incoming?.get(cid);
  incoming?.delete(cid);

  if (entry) {
    const declinerName = userInfo?.firstName || friends.get(cid)?.get(uid)?.firstName || 'Your friend';
    challengeDeclines.set(cid, { friendName: declinerName, declinedAt: Date.now() });
  }
  res.json({ success: true });
});

// GET /api/friend-challenge/declined/:userId — one-shot: did my pending challenge get declined?
app.get('/api/friend-challenge/declined/:userId', (req, res) => {
  const uid = String(req.params.userId);
  if (challengeDeclines.has(uid)) {
    const info = challengeDeclines.get(uid);
    challengeDeclines.delete(uid);
    return res.json({ declined: true, friendName: info.friendName });
  }
  res.json({ declined: false });
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

  // Cleanup stale matchmaking queue entries
  for (const [uid, entry] of matchQueue.entries()) {
    if (now - entry.joinedAt >= MATCH_QUEUE_TTL) {
      matchQueue.delete(uid);
    }
  }

  // Cleanup stale friend requests
  for (const [toUserId, incoming] of friendRequests.entries()) {
    for (const [fromUserId, entry] of incoming.entries()) {
      if (now - entry.createdAt >= FRIEND_REQUEST_TTL) incoming.delete(fromUserId);
    }
    if (incoming.size === 0) friendRequests.delete(toUserId);
  }

  // Cleanup stale friend challenges
  for (const [toUserId, incoming] of friendChallenges.entries()) {
    for (const [fromUserId, entry] of incoming.entries()) {
      if (now - entry.createdAt >= FRIEND_CHALLENGE_TTL) incoming.delete(fromUserId);
    }
    if (incoming.size === 0) friendChallenges.delete(toUserId);
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

// ---- Friends system ----
const userChatIds    = new Map(); // userId(string) -> private chatId, so we can DM them proactively
const friends        = new Map(); // userId(string) -> Map<friendId string, friendUserInfo>  (stored both directions)
const friendRequests = new Map(); // targetUserId(string) -> Map<fromUserId string, { userInfo, createdAt }>
const recentOpponents = new Map(); // userId(string) -> Map<opponentId string, { userInfo, lastPlayedAt }>  (mutual, powers "suggested friends")
const friendChallenges = new Map(); // targetUserId(string) -> Map<fromUserId string, { userInfo, timeControl, createdAt }>  (pending, needs explicit accept)
const challengeDeclines = new Map(); // challengerId(string) -> { friendName, declinedAt }  (one-shot, so the challenger's waiting UI can react)
const FRIEND_REQUEST_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const FRIEND_CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

// Remember each user's private chatId whenever they message the bot directly,
// so we can send them challenge/friend-request notifications later.
bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'private' && ctx.from?.id) {
    userChatIds.set(String(ctx.from.id), ctx.chat.id);
  }
  return next();
});

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

  // ---- Friend request via shared deep link: t.me/<bot>?start=friend_<userId> ----
  const payload = ctx.startPayload || '';
  if (payload.startsWith('friend_')) {
    const fromUserId = payload.slice('friend_'.length);
    const toUserId = String(ctx.from.id);

    if (fromUserId === toUserId) {
      await ctx.reply(`🙂 That's your own friend link — share it with someone else instead!`);
      return;
    }

    const alreadyFriends = friends.get(toUserId)?.has(fromUserId);
    if (alreadyFriends) {
      await ctx.reply(`✅ You're already friends! Open the app to challenge them.`);
      return;
    }

    const toUserInfo = {
      firstName: ctx.from.first_name || 'Player',
      lastName: ctx.from.last_name || '',
      username: ctx.from.username || '',
      photoUrl: ''
    };

    if (!friendRequests.has(fromUserId)) friendRequests.set(fromUserId, new Map());
    friendRequests.get(fromUserId).set(toUserId, { userInfo: toUserInfo, createdAt: Date.now() });

    await ctx.reply(`🤝 Friend request sent! They'll see it next time they open the app.`);

    // Notify the link owner right away if we know their chat
    const ownerChatId = userChatIds.get(fromUserId) || fromUserId;
    if (ownerChatId) {
      try {
        await bot.telegram.sendMessage(
          ownerChatId,
          `🤝 *${toUserInfo.firstName}* wants to be your friend on Chess!\n\nOpen the app to accept.`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '♟️ Open Chess', web_app: { url: `${BASE_URL}/` } }]] }
          }
        );
      } catch (err) {
        console.warn('Could not DM friend-request owner:', err.message);
      }
    }
    return;
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