import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import pLimit from "p-limit";
import inquirer from "inquirer";
import { WEBSITES, TYPES, STATUSES, GENRES } from "./data.js";
import { delay, downloadFile, logger, scrapper } from "./libs/utils.js";
import connectToDatabase from "./connectToDatabase.js";
import { collection, getDocs, query, where } from "firebase/firestore";

dotenv.config();
const limit = pLimit(5);

(async () => {
  const db = await connectToDatabase();

  // Reset the temp folder
  if (fs.existsSync("./src/temp")) {
    fs.rmSync("./src/temp", { recursive: true, force: true });
  }

  const { website, keyword } = await inquirer.prompt([
    {
      name: "website",
      type: "list",
      message: "Pilih website:",
      choices: Object.keys(WEBSITES),
    },
    {
      name: "keyword",
      type: "input",
      message: "Cari judul:",
    },
  ]);

  logger.info("Launching browser");
  const browser = await scrapper.launch({ headless: true, executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage();

  const websiteData = WEBSITES[website];
  const websiteUrl = keyword ? `${websiteData.search}${keyword}` : websiteData.default;

  logger.info(`Opening page: ${websiteUrl}`);
  page.goto(websiteUrl, { timeout: 0 });

  logger.info(`Fetching titles...`);
  const titleElement =
    keyword && websiteData.searchElements?.listTitle ? websiteData.searchElements.listTitle : websiteData.elements.listTitle;
  await page.waitForSelector(titleElement.parent, { timeout: 0 });

  const titles = await page.$$eval(
    titleElement.parent,
    (elements, titleElement) =>
      elements.map((element) => ({
        text: element.querySelector(titleElement.text).textContent.trim(),
        link: element.querySelector(titleElement.link).href,
      })),
    titleElement
  );

  logger.info(`${titles.length} comics found.`);

  const { comicTitle } = await inquirer.prompt([
    {
      name: "comicTitle",
      type: "rawlist",
      message: "Pilih komik:",
      choices: titles.map((title) => title.text),
    },
  ]);

  const selectedComic = titles.find((comic) => comic.text === comicTitle);
  websiteData.comicDelay && (await delay(websiteData.comicDelay));
  page.goto(selectedComic.link, { timeout: 0 });

  let comicId = null;
  let similiarTitle = null;
  let availableChapters = [];

  try {
    logger.info(`📢 Opening comic page: ${selectedComic.link}`);
    await page.waitForSelector(websiteData.elements.title);
    let title = (await page.$eval(websiteData.elements.title, (element) => element.textContent.trim())).replace(/(komik|comic)\s*/gi, "");

    logger.info(`Checking if comic ${title} exists in the API...`);

    const similiarTitleRef = collection(db, "similiar-title");

    const q = query(similiarTitleRef, where("raw", "==", title.toLocaleLowerCase()));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.size > 0) {
      const data = querySnapshot.docs[0].data();
      logger.info(`[SIMILAR-TITLE-FOUND] ${title} exists in similar titles database. using ${data.similiarTitle} instead`);
      similiarTitle = data.similiarTitle;
    }

    const response = await axios.get(`${process.env.API_ENDPOINT}/api/comics/find-one/?name=${similiarTitle ? similiarTitle : title}`, {
      headers: { Authorization: process.env.ACCESS_TOKEN },
    });

    comicId = response.data.payload.id;
    availableChapters = response.data.payload.chapters.map((chapter) => chapter.number);
    logger.info(`Comic ${similiarTitle ? similiarTitle : title} found. ID: ${comicId}`);
  } catch (error) {
    if (error.response?.status === 404) {
      logger.info(`Comic ${selectedComic.text} not found. Fetching metadata...`);

      const payload = {
        name: undefined,
        description: undefined,
        type_id: undefined,
        author: undefined,
        status_id: undefined,
        genres: undefined,
        rating: undefined,
        image: undefined,
      };

      try {
        // fetch title
        if (similiarTitle) {
          payload.name = similiarTitle;
        } else {
          await page.waitForSelector(websiteData.elements.title);
          payload.name = (await page.$eval(websiteData.elements.title, (element) => element.textContent.trim())).replace(
            /(komik|comic)\s*/gi,
            ""
          );
        }

        logger.info(`comic-name: Done!`);

        // fetch description
        await page.waitForSelector(websiteData.elements.description);
        payload.description = await page.$eval(websiteData.elements.description, (element) => element.textContent.trim());
        logger.info(`comic-description: Done!`);

        // fetch author
        await page.waitForSelector(websiteData.elements.author);
        payload.author = (await page.$eval(websiteData.elements.author, (element) => element.textContent.trim()))
          .replace(/(pengarang|author)\s*/gi, "")
          .trim();
        logger.info(`comic-author: Done!`);

        // fetch type_id
        await page.waitForSelector(websiteData.elements.type);
        const type = await page.$eval(websiteData.elements.type, (element) => element.textContent.trim());
        payload.type_id = TYPES[type] ?? undefined;
        logger.info(`comic-type: Done!`);

        // fetch status_id
        await page.waitForSelector(websiteData.elements.status);
        const status = (await page.$eval(websiteData.elements.status, (element) => element.textContent.trim())).replace(/status\s*/gi, "");
        payload.status_id = STATUSES[status] ?? STATUSES["ongoing"];
        logger.info(`comic-status: Done!`);

        // fetch genres
        await page.waitForSelector(websiteData.elements.genre);
        const genres = await page.$$eval(websiteData.elements.genre, (elements) => elements.map((element) => element.textContent.trim()));
        payload.genres = genres.map((genre) => GENRES[genre]).filter(Boolean);
        logger.info(`comic-genres: Done!`);

        // fetch rating
        const mangadexPage = await browser.newPage();

        try {
          await mangadexPage.goto("https://mangadex.org/", { timeout: 0 });
          await mangadexPage.waitForSelector(".placeholder-current");

          await mangadexPage.locator(".placeholder-current").fill(payload.name);
          await mangadexPage.locator(".manga-card-dense").click();

          await mangadexPage.waitForSelector("span.text-primary");
          payload.rating = await mangadexPage.$eval("span.text-primary", (element) => element.textContent.trim());
          logger.info(`comic-rating: Done!`);
        } catch (error) {
          logger.error(`⚠️ comic-rating: Failed : ${error.message}`);
        } finally {
          mangadexPage.close();
        }

        try {
          await page.waitForSelector(websiteData.elements.cover);
          const imageUrl = await page.$eval(websiteData.elements.cover, (element) => element.src.replace(/\?.*/g, ""));

          fs.mkdirSync("./src/temp");

          await downloadFile("./src/temp", `cover`, imageUrl);

          payload.image = fs.createReadStream(`./src/temp/cover.webp`);
          logger.info(`comic-image: Done!`);
        } catch (error) {
          logger.error(`⚠️ comic-image: Failed : ${error.message}`);
        }

        const response = await axios.post(`${process.env.API_ENDPOINT}/api/comics`, payload, {
          headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data" },
        });

        comicId = response.data.payload.id;
        logger.info(`✅ Comic created successfuly`);
      } catch (error) {
        logger.error(`⚠️ Failed to create comic : ${error.message}`);
        logger.error(error);
        process.exit(1);
      } finally {
        fs.rmSync("./src/temp", { recursive: true, force: true });
      }
    } else {
      logger.warn(`⚠️ Something went wrong`);
      console.log(error);
      process.exit(1);
    }
  }

  const { scrapMode } = await inquirer.prompt([
    {
      name: "scrapMode",
      type: "list",
      message: "Pilih mode:",
      choices: ["Auto", "Single"],
    },
  ]);

  // 8) Fetch the list of chapters available for the selected comic
  await page.waitForSelector(websiteData.elements.chapter.parent);
  logger.info(`Fetching Chapters`);

  let chapters = await page.$$eval(
    websiteData.elements.chapter.parent,
    (elements, websiteData) =>
      elements.map((element) => ({
        text: element.querySelector(websiteData.elements.chapter.text).textContent.trim().replace(/\n/g, ""),
        link: element.querySelector(websiteData.elements.chapter.link).href,
      })),
    websiteData
  );
  chapters = chapters.sort(
    (a, b) => Number(a.text.match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1] ?? 0) - Number(b.text.match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1] ?? 0)
  );

  let selectedChapter = [];

  if (scrapMode === "Single") {
    const { chapterTitle } = await inquirer.prompt([
      {
        name: "chapterTitle",
        type: "list",
        message: "Pilih chapter:",
        choices: chapters.map((chapter) => chapter.text),
      },
    ]);
    selectedChapter.push(chapters.find((chapter) => chapter.text === chapterTitle));
  } else {
    chapters.forEach((chapter) => {
      const chapterNumber = Number(chapter.text.match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1] ?? 0);
      if (!availableChapters.includes(chapterNumber)) selectedChapter.push(chapter);
    });
  }

  for (const chapter of selectedChapter) {
    try {
      fs.mkdirSync("./src/temp");

      websiteData.chapterDelay && (await delay(websiteData.chapterDelay));
      const startTime = Date.now();

      logger.info(`📢 Opening chapter page: ${chapter.link}`);
      page.goto(chapter.link, { timeout: 0 });

      logger.info(`Downloading images for chapter ${chapter.text}`);

      await page.waitForSelector(websiteData.elements.chapter.image);
      const images = await page.$$eval(websiteData.elements.chapter.image, (images) => images.map((image) => image.src));

      const downloadPromises = images.map((url) =>
        limit(async () => {
          try {
            const fileExtension = url.match(/\.\w+$/)?.[0];
            if (!fileExtension) return Promise.resolve(true);
            return await downloadFile("./src/temp", `${Date.now()}`, url);
          } catch (error) {
            throw error;
          }
        })
      );

      await Promise.all(downloadPromises);

      const chapterNumber = Number(chapter.text.match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1] ?? 0);

      const files = fs.readdirSync("./src/temp");

      const payload = {
        comic_id: comicId,
        number: chapterNumber,
        name: `Chapter ${chapterNumber}`,
        images: files.map((file) => {
          const filePath = `./src/temp/${file}`;
          return fs.createReadStream(filePath);
        }),
      };

      let delayTime = 1000;
      let attempts = 1;

      while (true) {
        try {
          logger.info(`Uploading chapter ${chapterNumber} attempt: ${attempts}`);

          await axios.post(`${process.env.API_ENDPOINT}/api/chapters`, payload, {
            headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data", Accept: "application/json" },
          });

          break;
        } catch (error) {
          if (error.response && error.response.status === 502) {
            logger.warn(`⚠️ 502 Error: Retrying due to server error...`);
          } else if (error.code === "ECONNABORTED" || error.code === "ECONNRESET") {
            logger.warn(`⚠️ Timeout Error: Retrying due to connection timeout...`);
          } else {
            console.log(error);
            logger.error(`⚠️ Failed to create chapter: ${error.message}`);
            break;
          }
          await delay(delayTime);

          delayTime *= 2;
          attempts++;

          if (attempts >= 5) {
            throw new Error("Maximum number of attempts reached");
          }
        }
      }

      const endTime = Date.now();
      logger.info(`🎉 Chapter ${chapter.text} processed in ${(endTime - startTime) / 1000} seconds`);
    } catch (error) {
      logger.error(`⚠️ Failed to process chapter ${chapter.link}, ${error.message}`);
      console.log(error);
      continue;
    } finally {
      fs.rmSync("./src/temp", { recursive: true, force: true });
    }
  }
  console.log("\n🙏 All Done.");

  await browser.close();
})();

process.on("unhandledRejection", (reason, promise) => {
  console.log("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.log("Uncaught Exception:", error.message, error.stack);
});
