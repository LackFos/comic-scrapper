import axios from "axios";
import dotenv from "dotenv";
import inquirer from "inquirer";
import { WEBSITES, TYPES, STATUSES, GENRES } from "./data.js";
import { delay, logger } from "./libs/utils.js";
import * as cheerio from "cheerio";
import connectToDatabase from "./connectToDatabase.js";
import { addDoc, collection, deleteDoc, doc, onSnapshot, updateDoc } from "firebase/firestore";

dotenv.config();
const deviceName = process.env.DEVICE_NAME;

const db = await connectToDatabase();
let failedJobs = [];

onSnapshot(collection(db, "failed-jobs"), (snapshot) => {
  failedJobs = snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((job) => !job.onRetry && !job.aborted);
});

// Main loop
(async () => {
  const { selectedType } = await askQuestion("type");

  let websiteToScrape = Object.values(WEBSITES);
  let keyword = null;

  const { selectedWebsite } = await askQuestion("website");

  if (selectedType === "Manual") {
    const { selectedKeyword } = await askQuestion("keyword");
    keyword = selectedKeyword;
    websiteToScrape = [WEBSITES[selectedWebsite]];
  } else if (selectedWebsite !== "All (Cron Only)") {
    websiteToScrape = [WEBSITES[selectedWebsite]];
  }

  for (const website of websiteToScrape) {
    const websiteUrl = keyword ? `${website.search}${keyword}` : website.default;
    const titleElement = keyword ? website.searchElements.listTitle : website.elements.listTitle;

    let comicToScrape = await fetchTitle(websiteUrl, titleElement);

    if (selectedType === "Manual") {
      const titleOptions = comicToScrape.map((title) => title.text);

      const { selectedTitle } = await askQuestion("title", titleOptions);
      comicToScrape = [comicToScrape.find((title) => title.text === selectedTitle)];
    }

    for (const selectedComic of comicToScrape) {
      const comic = await findOrCreateComic(selectedComic, website.elements);

      website.comicDelay && (await delay(website.comicDelay));

      logger.info(`[${deviceName}] Fetching Chapters`);
      let chaptersToScrape = comic.scrapeableChapters;

      if (selectedType === "Manual") {
        const { scrapeMode } = await askQuestion("mode");

        if (scrapeMode === "Single") {
          const chapterOptions = comic.scrapeableChapters.map((chapter) => chapter.text);
          const { selectedChapter } = await askQuestion("chapter", chapterOptions);
          chaptersToScrape = [comic.scrapeableChapters.find((chapter) => chapter.text === selectedChapter)];
        }
      }

      logger.info(`[${deviceName}] Chapters found : ${chaptersToScrape.length}`);

      while (chaptersToScrape.length > 0 || failedJobs.length > 0) {
        const failedJob = failedJobs[0];
        const isPerfomingFailedJob = Boolean(failedJob);

        let alternativeWebsite = isPerfomingFailedJob ? WEBSITES[WEBSITES[failedJob.latestWebsite].alternative] : null;

        let chapterToScrape = isPerfomingFailedJob ? { link: null, text: failedJob.chapterNumber } : chaptersToScrape.shift();

        if (isPerfomingFailedJob) {
          logger.info(`[${deviceName}] 😇 Interupted, failed job exists!`);
          await updateDoc(doc(db, "failed-jobs", failedJob.id), { onRetry: true });

          const alternativeComic = await axios.get(`${alternativeWebsite.search}${failedJob.comicName}`);
          const $alternativeComic = cheerio.load(alternativeComic.data);

          const matchedComicLink = $alternativeComic(
            `${alternativeWebsite.searchElements.listTitle.parent} ${alternativeWebsite.searchElements.listTitle.link}`
          ).attr("href");

          if (matchedComicLink) {
            const alternativeChapter = await axios.get(matchedComicLink);
            const $alternativeChapter = cheerio.load(alternativeChapter.data);

            const matchedChapter = $alternativeChapter(alternativeWebsite.elements.chapter.parent) // No need for `${}`
              .filter(
                (i, el) =>
                  Number(
                    $alternativeChapter(el)
                      .text()
                      .trim()
                      .match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1]
                  ) === Number(failedJob.chapterNumber)
              ); // Use $alternativeChapter instead of $

            if (matchedChapter.html()) {
              const $matchedChapter = cheerio.load(matchedChapter.html());
              chapterToScrape.link = $matchedChapter(`${alternativeWebsite.elements.chapter.link}`).attr("href");
            } else {
              logger.error(`[${deviceName}] ⚠️ Failed to find alternative chapter link`);
              await updateDoc(doc(collection(db, "failed-jobs"), failedJob.id), { aborted: true });
              continue;
            }
          }
        }

        const startTime = Date.now();

        const imageUrls = [];
        const isTsRead = isPerfomingFailedJob ? alternativeWebsite.isTsRead : website.isTsRead;
        const isLazyLoad = isPerfomingFailedJob ? alternativeWebsite.isLazyLoad : website.isLazyLoad;

        try {
          const response = await axios.get(chapterToScrape.link);
          const $ = cheerio.load(response.data);

          // Fetch all image urls
          if (isTsRead) {
            const scriptTag = $("script")
              .filter((i, el) => $(el).html().includes("ts_reader.run("))
              .html();

            if (!scriptTag) {
              console.log("Script ts_reader.run() tidak ditemukan.");
              return;
            }

            const jsonMatch = scriptTag.match(/ts_reader\.run\((.*?)\);/s);
            if (!jsonMatch) {
              console.log("Data tidak ditemukan dalam ts_reader.run().");
              return;
            }

            const jsonData = JSON.parse(jsonMatch[1]);

            jsonData.sources[0].images.forEach((image) => {
              imageUrls.push(
                image
                  .replace(/https:\/\/(?:i0|i2|i3)\.wp\.com/i, "https://")
                  .replace("https://", "https://i0.wp.com/")
                  .replace(/\?.*$/, "")
              );
            });
          } else {
            if (isLazyLoad) {
              const chapterImageElement = isPerfomingFailedJob ? alternativeWebsite.elements.chapter.image : website.elements.chapter.image;

              const noscriptHtml = $(`${chapterImageElement} noscript`).html();
              const $noscript = cheerio.load(noscriptHtml);

              $noscript("img").each((index, element) => {
                imageUrls.push(
                  `${$(element)
                    .attr("src")
                    .replace(/https:\/\/(?:i0|i2|i3)\.wp\.com/i, "https://")
                    .replace("https://", "https://i0.wp.com/")}`.replace(/\?.*$/, "")
                );
              });
            } else {
              const chapterImageElement = isPerfomingFailedJob ? alternativeWebsite.elements.chapter.image : website.elements.chapter.image;

              $(chapterImageElement).each((index, element) => {
                imageUrls.push(
                  `${$(element)
                    .attr("src")
                    .replace(/https:\/\/(?:i0|i2|i3)\.wp\.com/i, "https://")
                    .replace("https://", "https://i0.wp.com/")}`.replace(/\?.*$/, "")
                );
              });
            }
          }

          logger.info(`[${deviceName}] Checking images validity for chapter ${chapterToScrape.text}...`);

          for (const url of imageUrls) {
            await axios.get(url);
          }

          logger.info(`[${deviceName}] All images are valid for chapter ${chapterToScrape.text}`);
        } catch (error) {
          const failedUrl = error.config?.url || "Unknown URL";
          const errorMessage = error.response?.status ? `HTTP ${error.response.status} - ${error.response.statusText}` : error.message;

          logger.info(
            `[${deviceName}] ⚠️ Broken image found for chapter ${chapterToScrape.text} | URL: ${failedUrl} | ERROR: ${errorMessage}`
          );

          if (isPerfomingFailedJob) {
            await updateDoc(doc(collection(db, "failed-jobs"), failedJob.id), {
              error: errorMessage,
              onRetry: false,
              isCritical: alternativeWebsite.domain === "komik5.mangatoon.cc",
              latestWebsite: alternativeWebsite.domain,
            });
          } else {
            await addDoc(collection(db, "failed-jobs"), {
              comicId: comic.id ?? null,
              comicName: comic.title ?? null,
              chapterNumber: chapterToScrape.text ?? null,
              latestWebsite: isPerfomingFailedJob ? alternativeWebsite.domain : website.domain,
              error: errorMessage,
              onRetry: false,
              isCritical: false,
            });
          }

          continue;
        }

        try {
          const createChapterPayload = {
            comic_id: comic.id,
            number: chapterToScrape.text,
            name: `Chapter ${chapterToScrape.text}`,
            images: imageUrls,
          };

          const createChapterResponse = await axios.post(`${process.env.API_ENDPOINT}/api/chapters`, createChapterPayload, {
            headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data", Accept: "application/json" },
          });

          try {
            axios.post("https://api.indexnow.org/indexnow", {
              host: "https://komikdewasa.id",
              key: "55174ee475c14edcb2fe81d4d8833a0a",
              keyLocation: "https://komikdewasa.id/55174ee475c14edcb2fe81d4d8833a0a.txt",
              urlList: [`https://komikdewasa.id/baca/${createChapterResponse.data.payload.slug}`],
            });

            logger.info(`[${deviceName}] ⚙️ Sucessfuly send to IndexNow!`);
          } catch (error) {
            logger.error(`[${deviceName}] ⚠️ Failed to send to IndexNow : ${error.message}`);
          }

          if (isPerfomingFailedJob) {
            await deleteDoc(doc(collection(db, "failed-jobs"), failedJob.id));
          }

          logger.info(`[${deviceName}] 🎉 Chapter ${chapterToScrape.text} processed in ${(Date.now() - startTime) / 1000} seconds`);
        } catch (error) {
          console.log(error);
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
        choices: ["All (Cron Only)", ...Object.keys(WEBSITES)],
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

  try {
    const findGenres = await axios.get(`${process.env.API_ENDPOINT}/api/genres/bulk-find`, {
      headers: { Authorization: process.env.ACCESS_TOKEN },
      data: {
        genre_names: $(elements.genre)
          .map((index, element) => $(element).text().trim())
          .get(),
      },
    });

    comic.genres = findGenres.data.payload.map((genre) => genre.id);
  } catch (error) {
    logger.error(`[${deviceName}] ⚠️ Failed to find genres : ${error.message}`);
  }

  comic.image = $(elements.cover)
    .attr("src")
    .replace(/https:\/\/(?:i0|i2|i3)\.wp\.com/i, "https://")
    .replace("https://", "https://i0.wp.com/")
    .replace(/\?.*$/, "");

  return comic;
}

async function createComic(createComicPayload) {
  try {
    const createComicResponse = await axios.post(`${process.env.API_ENDPOINT}/api/comics`, createComicPayload, {
      headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data" },
    });

    try {
      axios.post("https://api.indexnow.org/indexnow", {
        host: "https://komikdewasa.id",
        key: "55174ee475c14edcb2fe81d4d8833a0a",
        keyLocation: "https://komikdewasa.id/55174ee475c14edcb2fe81d4d8833a0a.txt",
        urlList: [`https://komikdewasa.id/komik/${createComicResponse.data.payload.slug}`],
      });

      logger.info(`[${deviceName}] ⚙️ Sucessfuly send to IndexNow!`);
    } catch (error) {
      logger.error(`[${deviceName}] ⚠️ Failed to send to IndexNow : ${error.message}`);
    }

    logger.info(`[${deviceName}] ✅ Comic created successfuly`);

    return createComicResponse.data;
  } catch (error) {
    console.error(error);
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
