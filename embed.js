import dotenv from "dotenv";
import { QdrantClient } from "@qdrant/js-client-rest";
import https from "node:https";
import fs from "fs";
import { v4 } from "uuid";

dotenv.config();

const CORPUS_FILE = "corpus.json";
const COLLECTION_NAME = "news_articles";

const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
const qdrantClient = new QdrantClient({
  url: qdrantUrl,
  apiKey: process.env.QDRANT_API_KEY,
});

// call Jina embeddings via raw HTTPS (ESM)
const requestJinaEmbeddings = (texts) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "jina-embeddings-v2-base-en",
      input: texts,
    });

    const options = {
      hostname: "api.jina.ai",
      path: "/v1/embeddings",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${process.env.JINA_API_KEY}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const isOk =
          res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        if (!isOk) {
          return reject(
            new Error(
              `Jina embeddings HTTP ${
                res.statusCode
              }. Headers: ${JSON.stringify(res.headers)}. Body: ${body.slice(
                0,
                500
              )}`
            )
          );
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (e) {
          reject(
            new Error(
              `Failed to parse Jina response: ${e.message}. Body: ${body.slice(
                0,
                300
              )}`
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });

// split text into smaller chunks

const chunkText = (text, chunkSize = 300) => {
  const chunks = [];
  const sentences = text.split(/(?<=[.?!])\s+/);
  let currentChunk = "";
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > chunkSize) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = "";
    }
    currentChunk += sentence + " ";
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
};

const embedAndStore = async () => {
  console.log("Starting embedding process...");

  const collections = await qdrantClient.getCollections();
  const collectionExists = collections.collections.some(
    (c) => c.name === COLLECTION_NAME
  );

  if (!collectionExists) {
    console.log(`Collection ${COLLECTION_NAME} does not exist. Creating...`);
    await qdrantClient.createCollection(COLLECTION_NAME, {
      vectors: {
        size: 768,
        distance: "Cosine",
      },
    });
  } else {
    console.log(`Collection ${COLLECTION_NAME} already exists.`);
  }

  // Read data
  const corpusData = fs.readFileSync(CORPUS_FILE, "utf8");
  const articles = JSON.parse(corpusData);
  console.log(`Found ${articles.length} articles to process.`);

  // chunk, embed and upsert data
  let totalChunks = 0;
  for (const article of articles) {
    const chunks = chunkText(article.content);
    totalChunks += chunks.length;

    if (chunks.length === 0) continue;

    console.log(
      `- Article "${article.title.substring(0, 30)}..." has ${
        chunks.length
      } chunks. Embedding...`
    );

    // get embeddings from Jina via HTTPS with batching + retries
    const batchSize = 8;
    const allVectors = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize);
      let attempt = 0;
      while (true) {
        try {
          const resp = await requestJinaEmbeddings(batch);
          for (const item of resp.data) {
            allVectors.push(item.embedding);
          }
          // small delay to avoid rate/edge challenges
          await sleep(200);
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 3) throw err;
          const backoffMs = 500 * attempt;
          await sleep(backoffMs);
        }
      }
    }

    // prepare points for Qdrant
    const points = allVectors.map((vector, index) => ({
      id: v4(),
      vector: vector,
      payload: {
        text: chunks[index],
        article_title: article.title,
        article_url: article.url,
      },
    }));

    // upsert points to Qdrant in batches with retries
    const upsertBatchSize = 100;
    for (let start = 0; start < points.length; start += upsertBatchSize) {
      const slice = points.slice(start, start + upsertBatchSize);
      let attempt = 0;
      while (true) {
        try {
          await qdrantClient.upsert(COLLECTION_NAME, {
            wait: true,
            points: slice,
          });
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      // small pacing to be gentle on server
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log("\nEmbedding process complete!");
  console.log(
    `Successfully processed ${articles.length} articles into ${totalChunks} chunks and stored them in Qdrant.`
  );
};

embedAndStore().catch(console.error);
