FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

# Use npm install instead of npm ci
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
