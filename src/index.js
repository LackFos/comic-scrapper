import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import pLimit from "p-limit";
import inquirer from "inquirer";
import { addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import connectToDatabase from "./connectToDatabase.js";
import { WEBSITES, TYPES, STATUSES, GENRES } from "./data.js";
import { delay, downloadFile, logger, scrapper } from "./libs/utils.js";
import * as cheerio from "cheerio";

dotenv.config();

const deviceName = process.env.DEVICE_NAME;

async function getWebsite() {
  const { selectedWebsite, keyword } = await inquirer.prompt([
    {
      name: "selectedWebsite",
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

  const website = WEBSITES[selectedWebsite];
  const websiteUrl = keyword ? `${website.search}${keyword}` : website.default;

  return { website, websiteUrl, keyword };
}

async function getComic(website, websiteUrl, keyword) {
  const response = await axios.get(websiteUrl);
  const $ = cheerio.load(response.data);

  const titleElement = keyword && website.searchElements ? website.searchElements.listTitle : website.elements.listTitle;

  const availableTitles = $(titleElement.parent)
    .map((index, element) => ({
      text: $(element).find(titleElement.text).text().trim(),
      link: $(element).find(titleElement.link).attr("href"),
    }))
    .get();

  const { selectedTitle, scrapMode } = await inquirer.prompt([
    {
      name: "selectedTitle",
      type: "rawlist",
      message: "Pilih komik:",

      choices: availableTitles.map((title) => title.text),
    },
    {
      name: "scrapMode",
      type: "list",
      message: "Pilih mode:",
      choices: ["Auto", "Single"],
    },
  ]);

  return { selectedTitle, scrapMode, availableTitles };
}

// Main loop
(async () => {
  const { website, websiteUrl, keyword } = await getWebsite();
  const { selectedTitle, scrapMode, availableTitles } = await getComic(website, websiteUrl, keyword);

  const selectedComic = availableTitles.find((comic) => comic.text === selectedTitle);
  website.comicDelay && (await delay(website.comicDelay));

  console.log("\n");
  const resposne = await axios.get(selectedComic.link);
  const $ = cheerio.load(resposne.data);

  let comicId = null;
  let comicTitle = null;
  let comicChapters = [];

  comicTitle = $(website.elements.title)
    .text()
    .replace(/(komik|comic| Bahasa Indonesia)\s*/gi, "");

  try {
    const response = await axios.get(`${process.env.API_ENDPOINT}/api/comics/find-one/?name=${comicTitle}`, {
      headers: { Authorization: process.env.ACCESS_TOKEN },
    });

    comicId = response.data.payload.id;
    comicChapters = response.data.payload.chapters.map((chapter) => chapter.number);
    logger.info(`[${deviceName}] Comic ${comicTitle} found in API, with ID: ${comicId}`);
  } catch (error) {
    console.log(error);

    // if comic not found
    if (Boolean(error.response) && error.response.status === 404) {
      logger.info(`[${deviceName}] Comic ${comicTitle} not found in API`);

      const createComicPayload = {
        name: comicTitle,
        description: undefined,
        type_id: undefined,
        author: undefined,
        status_id: undefined,
        genres: undefined,
        rating: undefined,
        image: undefined,
      };

      createComicPayload.description = $(website.elements.description)
        .text()
        .replace(/(komik|comic| Bahasa Indonesia)\s*/gi, "")
        .trim();

      createComicPayload.author = $(website.elements.author)
        .text()
        .replace(/(pengarang|author)\s*/gi, "")
        .trim();

      createComicPayload.type_id = TYPES[$(website.elements.type).text().trim()] ?? undefined;

      createComicPayload.status_id =
        STATUSES[
          $(website.elements.status)
            .text()
            .replace(/status\s*/gi, "")
            .trim()
        ] ?? STATUSES["ongoing"];

      createComicPayload.genres = $(website.elements.genre)
        .map((index, element) => GENRES[$(element).text().trim()])
        .get();

      createComicPayload.image = $(website.elements.cover).attr("src").replace(/\?.*/g, "");
      console.log(createComicPayload);

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

        comicId = createComicResponse.data.payload.id;
        comicTitle = createComicResponse.data.payload.name;
        logger.info(`[${deviceName}] ✅ Comic created successfuly`);
      } catch (error) {
        logger.error(`[${deviceName}] ⚠️ Failed to create comic : ${error.message}`);
        console.error(error);
        process.exit(1);
      } finally {
        fs.rmSync("./src/temp", { recursive: true, force: true });
      }
    } else {
      logger.warn(`[${deviceName}] ⚠️ Something went wrong, ${error.message}`);
      process.exit(1);
    }
  }

  logger.info(`[${deviceName}] Fetching Chapters`);
  await page.waitForSelector(website.elements.chapter.parent);

  const availableChapters = (
    await page.$$eval(
      website.elements.chapter.parent,
      (elements, website) =>
        elements.map((element) => ({
          text:
            Number(
              element
                .querySelector(website.elements.chapter.text)
                .textContent.trim()
                .match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1]
            ) ?? 0,
          link: element.querySelector(website.elements.chapter.link).href,
        })),
      website
    )
  ).sort((a, b) => Number(a.text) - Number(b.text));

  let chaptersToScrape = [];
  const blackListedChapters = await getDocs(query(collection(db, "blacklist-chapter"), where("comicId", "==", comicId)));

  if (scrapMode === "Single") {
    const { selectedChapter } = await inquirer.prompt([
      {
        name: "selectedChapter",
        type: "list",
        message: "Pilih chapter:",
        choices: availableChapters.map((chapter) => chapter.text),
      },
    ]);

    chaptersToScrape.push(availableChapters.find((chapter) => chapter.text === selectedChapter));
  } else {
    let chaptersToSkip = comicChapters;

    if (!blackListedChapters.empty) {
      chaptersToSkip = chaptersToSkip.concat(blackListedChapters.docs[0].data().numbers);
    }

    availableChapters.forEach((chapter) => {
      if (!chaptersToSkip.includes(Number(chapter.text))) chaptersToScrape.push(chapter);
    });
  }

  logger.info(`[${deviceName}] Chapters found : ${chaptersToScrape.length}`);

  while (chaptersToScrape.length > 0 || failedJobs.length > 0) {
    const failedJob = failedJobs[0];
    const isPerfomingFailedJob = Boolean(failedJob);

    // Todo throw unexpected error if no alternative website
    let alternativeWebsite = isPerfomingFailedJob ? WEBSITES[failedJob.website] : null;
    let chapterToScrape = isPerfomingFailedJob ? { link: failedJob.link, text: failedJob.value } : chaptersToScrape.shift();

    if (isPerfomingFailedJob) {
      logger.info(`[${deviceName}] 😇 Interupted, failed job exists!`);

      await updateDoc(doc(db, "failed-jobs", failedJob.id), { onRetry: true });

      if (failedJob.isCritical) {
        logger.info(`[${deviceName}] 🚑 The failed job was CRITICAL!`);
        alternativeWebsite = WEBSITES[alternativeWebsite.alternative];

        try {
          page.goto(`${alternativeWebsite.search}${failedJob.title}`, { timeout: 0 });

          logger.info(`[${deviceName}] Searching for comic in alternative website...`);
          await page.waitForSelector(alternativeWebsite.elements.listTitle.parent);

          let alternativeComicLink = null;

          try {
            alternativeComicLink = await page.$eval(
              alternativeWebsite.elements.listTitle.parent,
              (element, alternativeWebsite) => element.querySelector(alternativeWebsite.elements.listTitle.link).href,
              alternativeWebsite
            );
          } catch (error) {
            throw new Error(`Comic not found in alternative website: ${error.message}`);
          }
          if (!alternativeComicLink) throw new Error(`Comic not found in alternative website: ${alternativeComicLink}`);

          page.goto(alternativeComicLink, { timeout: 0 });
          logger.info(`[${deviceName}] Searching for chapter in alternative website...`);
          await page.waitForSelector(alternativeWebsite.elements.chapter.parent);

          let alternativeChapterLink = null;

          try {
            alternativeChapterLink = await page.$$eval(
              alternativeWebsite.elements.chapter.parent,
              (elements, alternativeWebsite, failedJob) =>
                elements
                  .filter(
                    (element) =>
                      Number(
                        element
                          .querySelector(alternativeWebsite.elements.chapter.text)
                          .textContent.trim()
                          .match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1] ?? 0
                      ) === failedJob.value
                  )[0]
                  .querySelector(alternativeWebsite.elements.chapter.link).href,
              alternativeWebsite,
              failedJob
            );
          } catch (error) {
            throw new Error(`Chapter not found in alternative website: ${error.message}`);
          }
          if (!alternativeChapterLink) throw new Error(`Chapter not found in alternative website: ${alternativeChapterLink}`);

          chapterToScrape.link = alternativeChapterLink;
        } catch (error) {
          logger.error(`[${deviceName}] ⚠️ Failed to find alternative : ${error.message}`);

          const failedJobDocRef = doc(db, "failed-jobs", failedJob.id);

          await updateDoc(failedJobDocRef, { aborted: true });

          continue;
        }
      }
    }

    fs.mkdirSync("./src/temp");

    const startTime = Date.now();

    logger.info(`[${deviceName}] 📢 Opening chapter page: ${chapterToScrape.link}`);
    page.goto(chapterToScrape.link, { timeout: 0 });

    logger.info(`[${deviceName}] Downloading images for chapter ${chapterToScrape.text}`);

    await page.waitForSelector(isPerfomingFailedJob ? alternativeWebsite.elements.chapter.image : website.elements.chapter.image, {
      timeout: 0,
    });

    const isLazyLoad = isPerfomingFailedJob ? alternativeWebsite.isLazyLoad : website.isLazyLoad;

    const imagesUrl = await page.$$eval(
      isPerfomingFailedJob ? alternativeWebsite.elements.chapter.image : website.elements.chapter.image,
      (images, isLazyLoad) =>
        images.map((image) => (isLazyLoad ? (image.dataset.src ? image.dataset.src : image.src) : image.src.replace(/\?.*/g, ""))),
      isLazyLoad
    );

    try {
      const downloadPromises = imagesUrl.map((url, index) => limit(() => downloadFile("./src/temp", index, url)));

      const results = await Promise.allSettled(downloadPromises);

      results.forEach((result) => {
        if (result.status === "rejected") {
          const customError = new Error(result.reason);
          if (result.reason.isCritical) customError.isCritical = true;
          throw customError;
        }
      });

      const files = fs.readdirSync("./src/temp").sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      const imagesBuffer = files.map((file) => fs.createReadStream(`./src/temp/${file}`));

      if (imagesBuffer.length !== imagesUrl.length) {
        throw new Error(`❗ The downloaded images(${imagesBuffer.length}) doesnt match fetched urls(${imagesUrl.length})`);
      }

      const createChapterPayload = {
        comic_id: isPerfomingFailedJob ? failedJob.comicId : comicId,
        number: chapterToScrape.text,
        name: `Chapter ${chapterToScrape.text}`,
        images: imagesBuffer,
      };

      logger.info(`[${deviceName}] Uploading ${isPerfomingFailedJob ? failedJob.title : comicTitle} (${chapterToScrape.text})`);

      const createChapterResponse = await axios.post(`${process.env.API_ENDPOINT}/api/chapters`, createChapterPayload, {
        headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data", Accept: "application/json" },
      });

      try {
        axios.post("https://api.indexnow.org/indexnow", {
          host: "https://komikoi.com",
          key: "9da618746c5f47a69d45a7bdbdab8dce",
          keyLocation: "https://komikoi.com/9da618746c5f47a69d45a7bdbdab8dce.txt",
          urlList: [`https://komikoi.com/baca/${createChapterResponse.data.payload.slug}`],
        });

        logger.info(`[${deviceName}] ⚙️ Sucessfuly send to IndexNow!`);
      } catch (error) {
        logger.error(`[${deviceName}] ⚠️ Failed to send to IndexNow : ${error.message}`);
      }

      if (isPerfomingFailedJob) {
        const failedJobDocRef = doc(db, "failed-jobs", failedJob.id);
        await deleteDoc(failedJobDocRef);
      }

      logger.info(`[${deviceName}] 🎉 Chapter ${chapterToScrape.text} processed in ${(Date.now() - startTime) / 1000} seconds`);
    } catch (error) {
      logger.error(`[${deviceName}] ⚠️ Failed to create chapter ${chapterToScrape.link}, ${error.message}`);
      console.log(error);

      if (isPerfomingFailedJob) {
        if (error.response && Boolean(error.response.data?.errors?.number)) {
          await deleteDoc(doc(db, "failed-jobs", failedJob.id));
          continue;
        } else if (failedJob.isCritical) {
          await updateDoc(doc(db, "failed-jobs", failedJob.id), { aborted: true });
        } else {
          await updateDoc(doc(db, "failed-jobs", failedJob.id), { onRetry: false });
        }
      } else {
        if (error.response && Boolean(error.response.data?.errors?.number)) {
          continue;
        }

        const q = query(collection(db, "failed-jobs"), where("comicId", "==", comicId), where("value", "==", chapterToScrape.text));
        const querySnapshot = await getDocs(q);
        const isFailedJobExists = querySnapshot.docs.length > 0;

        if (!isFailedJobExists) {
          await addDoc(collection(db, "failed-jobs"), {
            website: website.domain,
            comicId: comicId,
            title: comicTitle,
            link: chapterToScrape.link,
            value: Number(chapterToScrape.text),
            onRetry: false,
            isCritical:
              error.isCritical ||
              (Boolean(error.response?.data?.errors) &&
                Object.keys(error.response?.data?.errors).some((key) => Boolean(key.match(/image/g)[0]))),
            aborted: false,
          });
        }
      }
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
