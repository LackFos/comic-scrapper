import axios from "axios";
import dotenv from "dotenv";
import inquirer from "inquirer";
import { WEBSITES, TYPES, STATUSES, GENRES } from "./data.js";
import { delay, logger } from "./libs/utils.js";
import * as cheerio from "cheerio";

dotenv.config();
const deviceName = process.env.DEVICE_NAME;

// Main loop
(async () => {
  const { selectedType } = await askQuestion("type");

  let websiteToScrape = Object.values(WEBSITES);
  let keyword = null;

  if (selectedType === "Manual") {
    const { selectedWebsite } = await askQuestion("website");
    const { selectedKeyword } = await askQuestion("keyword");

    websiteToScrape = WEBSITES[selectedWebsite];
    keyword = selectedKeyword;
  }

  for (const website of websiteToScrape) {
    const websiteUrl = keyword ? `${website.search}${keyword}` : website.default;
    const titleElement = keyword ? website.searchElements.listTitle : website.elements.listTitle;

    let comicToScrape = await fetchTitle(websiteUrl, titleElement);

    if (selectedType === "Manual") {
      const titleOptions = availableTitles.map((title) => title.text);
      const { selectedTitle } = await askQuestion("title", titleOptions);
      comicToScrape = availableTitles.find((title) => title.text === selectedTitle);
    }

    for (const selectedComic of comicToScrape) {
      const comic = await findOrCreateComic(selectedComic, website.elements);

      website.comicDelay && (await delay(website.comicDelay));

      const { scrapeMode } = await askQuestion("mode");

      logger.info(`[${deviceName}] Fetching Chapters`);
      let chaptersToScrape = comic.scrapeableChapters;

      if (selectedType === "Manual" && scrapeMode === "Single") {
        const chapterOptions = comic.scrapeableChapters.map((chapter) => chapter.text);
        const { selectedChapter } = await askQuestion("chapter", chapterOptions);
        chaptersToScrape = comic.scrapeableChapters.find((chapter) => chapter.text === selectedChapter);
      }

      logger.info(`[${deviceName}] Chapters found : ${chaptersToScrape.length}`);

      while (chaptersToScrape.length > 0) {
        let chapterToScrape = chaptersToScrape.shift();

        logger.info(`[${deviceName}] Downloading images for chapter ${chapterToScrape.text}`);

        const startTime = Date.now();
        const response = await axios.get(chapterToScrape.link);
        const $ = cheerio.load(response.data);

        const imageUrls = [];
        const isLazyLoad = website.isLazyLoad;

        if (isLazyLoad) {
          const noscriptHtml = $("noscript").html();
          const $noscript = cheerio.load(noscriptHtml);

          $noscript("img").each((index, element) => {
            imageUrls.push(`${$(element).attr("src").replace("https://", "https://i0.wp.com/")}`);
          });
        } else {
          $(website.elements.chapter.image).each((index, element) => {
            imageUrls.push(`${$(element).attr("src").replace("https://", "https://i0.wp.com/")}`);
          });
        }

        try {
          const createChapterPayload = {
            comic_id: comic.id,
            number: chapterToScrape.text,
            name: `Chapter ${chapterToScrape.text}`,
            images: imageUrls,
          };

          await axios.post(`${process.env.API_ENDPOINT}/api/chapters`, createChapterPayload, {
            headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data", Accept: "application/json" },
          });

          // try {
          //   axios.post("https://api.indexnow.org/indexnow", {
          //     host: "https://komikoi.com",
          //     key: "9da618746c5f47a69d45a7bdbdab8dce",
          //     keyLocation: "https://komikoi.com/9da618746c5f47a69d45a7bdbdab8dce.txt",
          //     urlList: [`https://komikoi.com/baca/${createChapterResponse.data.payload.slug}`],
          //   });

          //   logger.info(`[${deviceName}] ⚙️ Sucessfuly send to IndexNow!`);
          // } catch (error) {
          //   logger.error(`[${deviceName}] ⚠️ Failed to send to IndexNow : ${error.message}`);
          // }

          logger.info(`[${deviceName}] 🎉 Chapter ${chapterToScrape.text} processed in ${(Date.now() - startTime) / 1000} seconds`);
        } catch (error) {
          logger.error(`[${deviceName}] ⚠️ Failed to create chapter ${chapterToScrape.link}, ${error.message}`);
        }
      }
    }
  }

  console.log("\n🙏 All Done.");
})();

async function askQuestion(type, options) {
  if (type === "website") {
    return await inquirer.prompt([
      {
        name: "selectedWebsite",
        type: "list",
        message: "Pilih website:",
        choices: Object.keys(WEBSITES),
      },
    ]);
  }

  if (type === "keyword") {
    return await inquirer.prompt([
      {
        name: "selectedKeyword",
        type: "input",
        message: "Cari judul:",
      },
    ]);
  }

  if (type === "title") {
    return await inquirer.prompt([
      {
        name: "selectedTitle",
        type: "list",
        message: "Pilih komik:",
        choices: options,
      },
    ]);
  }

  if (type === "mode") {
    return await inquirer.prompt([
      {
        name: "scrapeMode",
        type: "list",
        message: "Pilih mode:",
        choices: ["Auto", "Single"],
      },
    ]);
  }

  if (type === "chapter") {
    return await inquirer.prompt([
      {
        name: "selectedChapter",
        type: "list",
        message: "Pilih chapter:",
        choices: options,
      },
    ]);
  }

  if (type === "type") {
    return await inquirer.prompt([
      {
        name: "selectedType",
        type: "list",
        message: "Pilih tipe:",
        choices: ["Cron", "Manual"],
      },
    ]);
  }
}

async function fetchTitle(websiteUrl, titleElement) {
  const response = await axios.get(websiteUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      Referer: "https://www.google.com/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "Accept-Language": "en-US,en;q=0.5",
    },
  });
  console.log(response.data);

  const $ = cheerio.load(response.data);

  // const titleElement = keyword && website.searchElements ? website.searchElements.listTitle : website.elements.listTitle;

  const availableTitles = $(titleElement.parent)
    .map((index, element) => ({
      text: $(element).find(titleElement.text).text().trim(),
      link: $(element).find(titleElement.link).attr("href"),
    }))
    .get();

  return availableTitles;
}

async function findOrCreateComic(selectedComic, elements) {
  const response = await axios.get(selectedComic.link);
  const $ = cheerio.load(response.data);

  const comic = {
    id: null,
    title: null,
    chapters: [],
    scrapeableChapters: [],
  };

  comic.title = $(elements.title)
    .text()
    .replace(/(komik|comic| Bahasa Indonesia)\s*/gi, "")
    .trim();

  try {
    const response = await axios.get(`${process.env.API_ENDPOINT}/api/comics/find-one/?name=${comic.title}`, {
      headers: { Authorization: process.env.ACCESS_TOKEN },
    });

    comic.id = response.data.payload.id;
    comic.chapters = response.data.payload.chapters.map((chapter) => chapter.number);

    logger.info(`[${deviceName}] Comic ${comic.title} found in API, with ID: ${comic.id}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      logger.info(`[${deviceName}] Comic ${comic.title} not found in API`);

      const createComicPayload = await scrapeComic($, elements, comic.title);
      const response = await createComic(createComicPayload);

      comic.id = response.payload.id;
    } else {
      logger.warn(`[${deviceName}] ⚠️ Something went wrong while finding comic in API, ${error.message}`);
      process.exit(1);
    }
  }

  const availableChapters = $(elements.chapter.parent)
    .map((index, element) => {
      return {
        text:
          Number(
            $(element)
              .find(elements.chapter.text)
              .text()
              .trim()
              .match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1]
          ) ?? 0,
        link: $(element).find(elements.chapter.link).attr("href"),
      };
    })
    .get();

  comic.scrapeableChapters = availableChapters
    .filter((chapter) => {
      return !comic.chapters.includes(chapter.text);
    })
    .sort((a, b) => Number(a.text) - Number(b.text));

  return comic;
}

async function scrapeComic($, elements, name) {
  const comic = {
    name,
    description: undefined,
    type_id: undefined,
    author: undefined,
    status_id: undefined,
    genres: undefined,
    rating: undefined,
    image: undefined,
  };

  comic.description = $(elements.description)
    .text()
    .replace(/(komik|comic| Bahasa Indonesia)\s*/gi, "")
    .trim();

  comic.author = $(elements.author)
    .text()
    .replace(/(pengarang|author)\s*/gi, "")
    .trim();

  comic.type_id = TYPES[$(elements.type).text().trim()] ?? undefined;

  comic.status_id =
    STATUSES[
      $(elements.status)
        .text()
        .replace(/status\s*/gi, "")
        .trim()
    ] ?? STATUSES["ongoing"];

  comic.genres = $(elements.genre)
    .map((index, element) => GENRES[$(element).text().trim()])
    .get();

  comic.image = $(elements.cover).attr("src").replace(/\?.*/g, "");

  return comic;
}

async function createComic(createComicPayload) {
  try {
    const createComicResponse = await axios.post(`${process.env.API_ENDPOINT}/api/comics`, createComicPayload, {
      headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data" },
    });

    // try {
    //   axios.post("https://api.indexnow.org/indexnow", {
    //     host: "https://komikoi.com",
    //     key: "9da618746c5f47a69d45a7bdbdab8dce",
    //     keyLocation: "https://komikoi.com/9da618746c5f47a69d45a7bdbdab8dce.txt",
    //     urlList: [`https://komikoi.com/komik/${createComicResponse.data.payload.slug}`],
    //   });

    //   logger.info(`[${deviceName}] ⚙️ Sucessfuly send to IndexNow!`);
    // } catch (error) {
    //   logger.error(`[${deviceName}] ⚠️ Failed to send to IndexNow : ${error.message}`);
    // }

    logger.info(`[${deviceName}] ✅ Comic created successfuly`);

    return createComicResponse.data;
  } catch (error) {
    logger.error(`[${deviceName}] ⚠️ Failed to create comic : ${error.message}`);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason, promise) => {
  console.log("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.log("Uncaught Exception:", error.message, error.stack);
});
