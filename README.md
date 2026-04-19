# Chess Telegram Bot

Multiplayer chess bot for Telegram with real-time gameplay.

## Deployment on Render (Free Plan)

1. **Create a Bot Token**
   - Message @BotFather on Telegram
   - Send `/newbot` and follow instructions
   - Copy your bot token

2. **Deploy on Render**
   - Push this code to a GitHub repository
   - Log in to [Render.com](https://render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repo
   - Configure:
     - Name: `chess-bot`
     - Environment: `Node`
     - Build Command: `npm install`
     - Start Command: `npm start`
   - Add Environment Variables:
     - `BOT_TOKEN`: your bot token
     - `BASE_URL`: your Render URL (e.g., `https://chess-bot.onrender.com`)
   - Click "Create Web Service"

3. **Set up Webhook (Optional)**
   - The bot uses long polling by default, which works on free tier
   - No additional configuration needed

## Local Development

1. Copy `.env.example` to `.env` and add your bot token
2. Run `npm install`
3. Run `npm start`
4. Open `http://localhost:3000` to test

## Usage

1. Start the bot: `/start`
2. Create a game: `/newgame`
3. Share the white/black links with your opponent
4. Both players open their links and play!

## Features

- Real-time multiplayer chess
- Full chess rules (castling, en passant, promotion)
- Visual board with custom piece designs
- Spectator mode
- Game state sync between players
