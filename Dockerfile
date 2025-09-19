FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package manifests first for better layer caching
COPY package*.json ./

# Install dependencies (prod only)
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose port (not required for this bot, but Railway expects a service)
EXPOSE 3000

# Default envs (can be overridden on Railway)
ENV NODE_ENV=production

# Start the bot (long-running process)
CMD ["npm", "start"]


