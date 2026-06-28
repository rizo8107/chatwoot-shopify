# Stage 1: Build React Frontend Client
FROM node:20-alpine AS client-builder
WORKDIR /app/client

# Copy package descriptors and lockfiles
COPY client/package*.json ./
RUN npm ci

# Copy client source code and build production bundle
COPY client/ ./
RUN npm run build

# Stage 2: Create Production Server Image
FROM node:20-alpine
WORKDIR /app

# Install package descriptors for backend dependencies
COPY server/package*.json ./server/

# Install server production dependencies
RUN npm ci --prefix server --only=production

# Copy server application source code
COPY server/ ./server/

# Copy compiled frontend assets from client-builder
COPY --from=client-builder /app/client/dist ./client/dist

# Setup production environment parameters
ENV PORT=3000
ENV NODE_ENV=production
# Data is stored in InsForge (cloud Postgres). Provide the connection string at
# runtime via INSFORGE_DATABASE_URL (e.g. docker run -e INSFORGE_DATABASE_URL=...).

# Expose backend application port
EXPOSE 3000

# Run Express server
CMD ["node", "server/index.js"]
