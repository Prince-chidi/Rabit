// server.js
const express = require("express");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const app = express();
const PORT = process.env.PORT || 3000;
const cors = require("cors");
app.use(express.json());
app.use(cors());
var page;
var browser;
// Apply stealth plugin to bypass Cloudflare
puppeteerExtra.use(StealthPlugin());

// Utility logger
const log = (...args) => console.log(new Date().toISOString(), ...args);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/scrape", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  console.log("requesthit");

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const startTime = Date.now();
  let { country, degree, fields } = req.body;
  log("Request payload:", { country, degree, fields });
  sendEvent("progress", {
    message: `Scraping ${degree} programs in ${country}...`,
  });

  try {
    // Validate inputs
    if (!country || !degree) throw new Error("country and degree are required");
    if (!Array.isArray(fields) || fields.length === 0) {
      sendEvent("progress", { message: `No valid fields requested` });
      throw new Error("fields must be a non-empty array");
    }

    // Map degree to portal
    const portalMap = { msc: "master", bsc: "bachelor", phd: "phd" };
    const portal = portalMap[degree.toLowerCase()];
    if (!portal) throw new Error(`unsupported degree: ${degree}`);

    // Whitelist valid fields
    const allowed = new Set([
      "id",
      "programName",
      "university",
      "city_country",
      "duration",
      "tuitionFee",
      "applicationLink",
    ]);
    fields = fields.filter((f) => allowed.has(f));
    if (fields.length === 0) throw new Error("no valid fields requested");

    // Determine if detail-page fetch is needed
    const detailKeys = ["duration", "tuitionFee", "applicationLink"];
    const needDetail = fields.some((f) => detailKeys.includes(f));

    // Launch Puppeteer with stealth
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36"
    );
    await page.setDefaultNavigationTimeout(6000000000);

    const results = [];
    let pageIndex = 1;

    // Pagination loop
    while (true) {
      await browser.close();

      // Launch Puppeteer with stealth
      browser = await puppeteerExtra.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36"
      );
      await page.setDefaultNavigationTimeout(60000);

      const listUrl = `https://www.${portal}sportal.com/search/${portal}/${encodeURIComponent(
        country.toLowerCase()
      )}?page=${pageIndex}`;
      log("Loading list page:", listUrl);
      sendEvent("progress", { message: `Loading page ${listUrl}` });
      await page.goto(listUrl, { waitUntil: "networkidle2" });

      // Check if any program cards are present
      const cardSelector = "a.SearchStudyCard";
      const exists = await page.$(cardSelector);
      if (!exists) {
        log("No cards found on page", pageIndex);
        sendEvent("warning", {
          message: `No more cards found on page ${pageIndex}`,
        });
        break;
      }

      // Extract list-level data for all cards on this page
      const cards = await page.$$eval(cardSelector, (els) =>
        els.map((a) => ({
          href: a.href,
          programName:
            a.querySelector("h2.StudyName")?.innerText.trim() || null,
          university:
            a.querySelector(".OrganisationName")?.innerText.trim() || null,
          city_country:
            a.querySelector(".OrganisationLocation")?.innerText.trim() || null,
        }))
      );
      log(`Found ${cards.length} cards on page ${pageIndex}`);
      sendEvent("progress", {
        message: `Found ${cards.length} programs on page ${pageIndex}`,
      });

      // Process each card
      for (const card of cards) {
        const entry = {};
        entry.country = country;
        // ID if requested
        if (fields.includes("id")) {
          const m = card.href.match(/studies\/(\d+)/);
          entry.id = m ? m[1] : null;
        }
        // Populate list-level fields
        if (fields.includes("programName"))
          entry.programName = card.programName;
        if (fields.includes("university")) entry.university = card.university;
        if (fields.includes("city_country"))
          entry.city_country = card.city_country;

        // Fetch detail page only if needed
        if (needDetail) {
          const detailPage = await browser.newPage();
          await detailPage.setUserAgent(page._userAgent);
          await detailPage.setDefaultNavigationTimeout(60000);
          log("Loading program-detail page:", card.href);
          sendEvent("progress", {
            message: `Loading program-detail page: ${card.href}`,
          });

          await detailPage.goto(card.href, { waitUntil: "networkidle2" });

          if (fields.includes("duration")) {
            entry.duration = await detailPage
              .$eval(".js-duration", (el) => el.innerText.trim())
              .catch(() => null);
          }
          if (fields.includes("tuitionFee")) {
            entry.tuitionFee = await detailPage
              .$eval(".Title", (el) => el.getAttribute("data-original-amount"))
              .catch(() => null);
          }
          if (fields.includes("applicationLink")) {
            entry.applicationLink = await detailPage
              .$eval("a.ChampionButton.StudyLink", (el) => el.href)
              .catch(() => null);
          }
          
          
          await detailPage.close();
        }

        results.push(entry);
        log("Scraped entry:", entry);
        sendEvent("entry", { entry });
            }

      pageIndex++;
    }

    await browser.close();
    const took = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`Scraping complete: ${results.length} items in ${took}`);
    // res.json({ count: results.length, results, took });
    sendEvent("done", { count: results.length, results, took });
    res.end();
  } catch (err) {
    log("Error in /scrape:", err.message);
    sendEvent("error", { message: err.message });
    res.end();
  }
});

app.listen(PORT, () => log(`Server listening on port ${PORT}`));
