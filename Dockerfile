FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY data ./data
ENV NODE_ENV=production PORT=3000
RUN mkdir -p var && chown node:node var
USER node
EXPOSE 3000
CMD ["node", "src/server/index.js"]
