# Build na raiz do repositório (pasta que contém server/, event/, admin/, …)
FROM node:20-alpine
WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY . .

WORKDIR /app/server
ENV NODE_ENV=production
CMD ["node", "index.js"]
