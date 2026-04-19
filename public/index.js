// ========== CHAT STORAGE ==========
const chatMessages = new Map(); // gameId -> array of messages

// POST /api/game/:gameId/chat – send a message
app.post('/api/game/:gameId/chat', (req, res) => {
  const { gameId } = req.params;
  const { userId, text } = req.body;
  if (!userId || !text || text.trim().length === 0) {
    return res.status(400).json({ error: 'userId and text required' });
  }

  const game = games.get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  // Determine user's color (for message styling)
  let color = 'spectator';
  if (game.whiteUserId === userId) color = 'white';
  else if (game.blackUserId === userId) color = 'black';

  // Get user's display name
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

  if (!chatMessages.has(gameId)) chatMessages.set(gameId, []);
  const messages = chatMessages.get(gameId);
  messages.push(message);
  // Keep last 100 messages
  if (messages.length > 100) messages.shift();

  res.json({ success: true, message });
});

// GET /api/game/:gameId/chat?since=timestamp – fetch new messages
app.get('/api/game/:gameId/chat', (req, res) => {
  const { gameId } = req.params;
  const since = parseInt(req.query.since) || 0;

  const messages = chatMessages.get(gameId) || [];
  const newMessages = messages.filter(m => m.timestamp > since);
  res.json({ messages: newMessages });
});