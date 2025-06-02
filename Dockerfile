FROM node:20-alpine

# ffmpeg + tini (pid 1)
RUN apk add --no-cache ffmpeg tini

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server.js"]
