# Chatbot RAG Backend

A minimal Retrieval-Augmented Generation (RAG) backend for a news Q&A assistant. It:

- Ingests news articles from multiple RSS feeds and scrapes article text into `corpus.json`.
- Generates embeddings using Jina AI and stores chunked documents in a Qdrant vector DB.
- Serves a chat API that retrieves relevant context from Qdrant and answers with Google Gemini.
- Persists per-session chat history in Redis.

## Tech stack

- Node.js (ESM)
- Express (API)
- Qdrant (vector database)
- Redis (chat history)
- Jina AI Embeddings (`jina-embeddings-v2-base-en`)
- Google Gemini (`gemini-2.5-flash`)

## Prerequisites

- Node.js 18+
- Cloud services:
  - Qdrant Cloud (recommended) or any hosted Qdrant endpoint
  - Managed Redis (e.g., Render Redis, Upstash, Redis Cloud)

Optional for local development:

```bash
# Qdrant
docker run -p 6333:6333 -p 6334:6334 -v qdrant_storage:/qdrant/storage ghcr.io/qdrant/qdrant:latest
# Redis
docker run -p 6379:6379 --name redis -d redis:7-alpine
```

## Setup

```bash
npm install
```

Create a `.env` file in this directory:

```bash
GOOGLE_API_KEY=your_google_api_key
JINA_API_KEY=your_jina_api_key
QDRANT_URL=https://YOUR-QDRANT-CLOUD-ENDPOINT
QDRANT_API_KEY=your_qdrant_api_key
REDIS_URL=rediss://default:password@YOUR-REDIS-HOST:PORT
```

- `QDRANT_URL`: your Qdrant Cloud endpoint (HTTPS)
- `QDRANT_API_KEY`: API key from Qdrant Cloud (if your cluster requires auth)
- `REDIS_URL`: managed Redis connection URL. If it starts with `rediss://`, TLS is required and will be auto-detected by the `redis` client.

## Data pipeline

1. Ingest news into `corpus.json`:

```bash
npm run ingest
```

- Pulls from several RSS feeds (BBC, NYT World, Reuters, Wired, NPR).
- Scrapes article bodies with Cheerio.
- Saves up to 50 articles into `corpus.json`.

2. Embed and upsert into Qdrant (Cloud):

```bash
npm run embed
```

- Splits each article into ~300-char sentence-aware chunks.
- Gets embeddings from Jina and upserts vectors into the `news_articles` collection in Qdrant (size 768, cosine distance).
- Uses `QDRANT_URL` and `QDRANT_API_KEY` from the environment.

## Run the API server

```bash
npm start
```

- Starts on `http://localhost:3001` (or the `PORT` env var).
- Requires `QDRANT_URL`, `QDRANT_API_KEY` (if applicable), `REDIS_URL`, `GOOGLE_API_KEY`, and `JINA_API_KEY` to be set.

## API

- GET `/` → health check

  - Response: `{ "status": "ok" }`

- POST `/api/chat`

  - Body: `{ "query": string, "sessionId"?: string }`
  - Behavior: embeds the query (Jina) → vector search (Qdrant, top 3) → prompts Gemini with retrieved context → stores both user and bot messages in Redis under `chat_history:{sessionId}`.
  - Response: `{ "answer": string, "sessionId": string }`

- GET `/api/history/:sessionId`

  - Response: `{ "messages": Array<{ sender: "user"|"bot", text: string }> }`

- POST `/api/clear/:sessionId`
  - Response: `{ "message": "Session cleared successfully." }`

### cURL examples

```bash
# Health
curl http://localhost:3001/

# Chat (new session)
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"What are the latest developments in AI regulation?"}'

# Chat (existing session)
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"Any updates since then?","sessionId":"<your-session-id>"}'

# History
curl http://localhost:3001/api/history/<your-session-id>

# Clear session
curl -X POST http://localhost:3001/api/clear/<your-session-id>
```

## Configuration notes

- Qdrant
  - URL: `QDRANT_URL` (HTTPS endpoint in cloud)
  - API key: `QDRANT_API_KEY`
  - Collection: `news_articles`
  - Embeddings dimension: 768 (Jina model)
- Redis
  - URL: `REDIS_URL` (e.g., `rediss://...`) — TLS detected automatically when using `rediss://`
- Server
  - Port: `PORT` (default 3001)
- CORS is enabled for the Express app.

## Deploying on Render (with cloud Qdrant & managed Redis)

1. Push this repo to GitHub.
2. Create a Render Web Service from this repo.
   - Build Command: `npm install`
   - Start Command: `npm run start`
3. Set Environment Variables on the Web Service:
   - `GOOGLE_API_KEY`: your key
   - `JINA_API_KEY`: your key
   - `QDRANT_URL`: your Qdrant Cloud endpoint, e.g. `https://YOUR-qdrant-xxxx.qdrant.tech`
   - `QDRANT_API_KEY`: your Qdrant API key (if required)
   - `REDIS_URL`: your managed Redis URL (Render Redis, Upstash, etc.). Prefer `rediss://` URLs for TLS.
   - `PORT`: leave empty; Render injects it automatically and the app uses it.
4. One-off data jobs (optional):
   - In the Web Service → Shell, run `npm run ingest` then `npm run embed`.
   - These commands will use your cloud Qdrant and managed Redis env vars.

Notes

- Ensure outbound access to Jina and Google APIs is allowed from your Render service.
- If you rotate keys in Qdrant or Redis, update the Render env vars accordingly and redeploy.

## Troubleshooting

- Qdrant connectivity: verify `QDRANT_URL` is reachable and the `QDRANT_API_KEY` is valid.
- Redis connectivity: ensure `REDIS_URL` is correct; if using TLS, it should start with `rediss://`.
- Embeddings: verify `JINA_API_KEY` and network egress.
- Generation: verify `GOOGLE_API_KEY`.
- Empty `corpus.json`: re-run ingestion.

## License

ISC
