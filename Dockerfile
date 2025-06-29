# Dockerfile

# 1) Base image with Node 18+
FROM node:18-slim

# 2) Install Chrome for Puppeteer
RUN apt-get update \
 && apt-get install -y wget gnupg ca-certificates --no-install-recommends \
 && wget -qO - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
 && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y google-chrome-stable --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# 3) Create app dir & install deps
WORKDIR /app
COPY package*.json ./
RUN npm install

# 4) Copy your code
COPY . .

# 5) Expose port & run
EXPOSE 3000
CMD ["node", "server.js"]
