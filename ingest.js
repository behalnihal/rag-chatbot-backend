import axios from "axios";
import RSSParser from "rss-parser";
import * as cheerio from "cheerio";
import fs from "fs";

// --- List of RSS feeds to try in order ---
const RSS_FEED_URLS = [
  "http://feeds.bbci.co.uk/news/rss.xml", // BBC News
  "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", // NYT World
  "http://feeds.reuters.com/Reuters/worldNews", // Reuters World
  "https://www.wired.com/feed/rss", // Wired
  "https://feeds.npr.org/1001/rss.xml", // NPR News
];

const MAX_ARTICLES = 50;
const OUTPUT_FILE = "corpus.json";

const ingestData = async () => {
  console.log("Starting news ingestion from multiple feeds...");
  const articles = [];

  // Loop through each feed URL
  for (const url of RSS_FEED_URLS) {
    // If we already have enough articles, stop processing more feeds
    if (articles.length >= MAX_ARTICLES) {
      console.log("Reached max articles count. Stopping.");
      break;
    }

    console.log(`\nFetching from: ${url}`);
    const parser = new RSSParser();

    let feed;
    try {
      feed = await parser.parseURL(url);
    } catch (error) {
      console.error(
        `Could not fetch or parse RSS feed. Skipping. Error: ${error.message}`
      );
      continue; // Move to the next feed
    }

    for (const item of feed.items) {
      // Check again in case we hit the max in the middle of a feed
      if (articles.length >= MAX_ARTICLES) {
        break;
      }

      if (!item.link) {
        console.warn(`- Skipping item with no link: "${item.title}"`);
        continue;
      }

      try {
        process.stdout.write(`- Fetching: ${item.title.substring(0, 40)}...\r`);

        const response = await axios.get(item.link, {
          timeout: 5000, // Add a 5-second timeout
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        const $ = cheerio.load(response.data);

        // This generic selector looks for paragraphs inside common article tags.
        // It's not perfect for every site but works for many.
        let articleText = "";
        $("article p, .article-body p, .story-body p").each((i, elem) => {
          articleText += $(elem).text() + "\n";
        });

        articleText = articleText.replace(/\s\s+/g, " ").trim();

        if (articleText.length > 200) {
          articles.push({
            id: `article_${articles.length + 1}`,
            title: item.title,
            url: item.link,
            content: articleText,
          });
          console.log(
            `- Success! Added article #${articles.length}. Title: ${item.title}`
          );
          break;
        }
      } catch (error) {
        // Silently fail on individual article errors to keep the log clean
      }
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(articles, null, 2));
  console.log(`\n----------------------------------------------------`);
  console.log(
    `Successfully ingested ${articles.length} articles and saved to ${OUTPUT_FILE}`
  );
  console.log(`----------------------------------------------------`);
};

ingestData();
