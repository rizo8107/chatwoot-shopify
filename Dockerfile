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
ENV APP_PORT=3000
ENV NODE_ENV=production
# Data is stored in PostgreSQL. Provide DATABASE_URL and DATABASE_SSL at runtime.

# Expose backend application port
EXPOSE 3000

# Let Docker/Coolify route traffic only after Express and PostgreSQL are ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

# Run Express server
CMD ["node", "server/index.js"]
