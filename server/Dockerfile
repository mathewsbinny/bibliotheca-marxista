# The catalogue API. Build from the repository root:
#   docker build -f server/Dockerfile -t bibliotheca-api .
#   docker run -d -p 8787:8787 -v /srv/bibliotheca/db:/app/db \
#     -e SITE_ORIGIN=https://bibliotheca-marxista.org -e TRUST_PROXY=1 bibliotheca-api
# The database (db/catalogue.sqlite, made by `npm run build`) is mounted, not copied into the image,
# so an updated catalogue is deployed by replacing that file (see README, "Deploying").
FROM node:22-slim
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev better-sqlite3@13 && npm cache clean --force
COPY server/ ./server/
ENV PORT=8787 CATALOGUE_DB=/app/db/catalogue.sqlite NODE_ENV=production
EXPOSE 8787
USER node
CMD ["node", "server/server.mjs"]
