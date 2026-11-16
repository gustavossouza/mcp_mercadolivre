FROM node:24.22.3-alpine3.24 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.3-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN mkdir -p /app/data && chown node:node /app/data
ENV ML_TOKENS_FILE=/app/data/tokens.json
USER node
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
