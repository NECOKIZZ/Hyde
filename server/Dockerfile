FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production JOBS_FILE=/data/jobs.json
VOLUME /data
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/server.ts"]
