FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV RELEASES_DIR=/data/releases
EXPOSE 3000
CMD ["node", "server.js"]
