FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
ENV NODE_ENV=production DATA_DIR=/data PORT=9000
RUN mkdir -p /data
EXPOSE 9000
CMD ["node", "dist/server.js"]
