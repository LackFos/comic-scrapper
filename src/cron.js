import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import pLimit from "p-limit";
import cron from "node-cron";
import inquirer from "inquirer";
import { addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import connectToDatabase from "./connectToDatabase.js";
import { WEBSITES, TYPES, STATUSES, GENRES } from "./data.js";
import { delay, downloadFile, logger, scrapper } from "./libs/utils.js";

dotenv.config();
const limit = pLimit(5);

const db = await connectToDatabase();
const deviceName = process.env.DEVICE_NAME;
let onScrapping = false;

// Keep track of failed jobs
let failedJobs = [];

onSnapshot(collection(db, "failed-jobs"), (snapshot) => {
  failedJobs = snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((job) => job.onRetry === false && job.aborted === false);
});

// Main loop
(async () => {
  if (fs.existsSync("./src/temp")) {
    fs.rmSync("./src/temp", { recursive: true, force: true });
  }

  const { selectedWebsite } = await inquirer.prompt([
    {
      name: "selectedWebsite",
      type: "list",
      message: "Pilih website:",
      choices: [...Object.keys(WEBSITES), "All"],
    },
  ]);

  console.log("\nLaunching browser...");
  const browser = await scrapper.launch({ headless: true });
  const websites = selectedWebsite === "All" ? Object.values(WEBSITES) : [WEBSITES[selectedWebsite]];

  async function startScrapping() {
    onScrapping = true;

    for (const website of websites) {
      const page = await browser.newPage();

      const websiteUrl = website.default;

      console.log(`Opening website: ${websiteUrl}`);
      page.goto(websiteUrl, { timeout: 0 });

      console.log(`Fetching titles...\n`);
      await page.waitForSelector(website.elements.listTitle.parent, { timeout: 0 });

      const availableTitles = await page.$$eval(
        website.elements.listTitle.parent,
        (elements, website) => {
          console.log(elements);

          return elements.map((element) => ({
            text: element.querySelector(website.elements.listTitle.text).textContent.trim(),
            link: element.querySelector(website.elements.listTitle.link).href,
          }));
        },
        website
      );

      console.log(`comics found : \n${availableTitles.map((title, index) => `${index + 1}. ${title.text}`).join("\n")}`);

      for (const title of availableTitles.reverse()) {
        website.comicDelay && (await delay(website.comicDelay));

        console.log("\n");
        logger.info(`[${deviceName}] 📢 Opening comic "${title.text}": ${title.link}`);
        page.goto(title.link, { timeout: 0 });

        let comicId = null;
        let comicTitle = null;
        let comicChapters = [];

        await page.waitForSelector(website.elements.title);
        comicTitle = (await page.$eval(website.elements.title, (element) => element.textContent.trim())).replace(
          /(komik|comic| Bahasa Indonesia)\s*/gi,
          ""
        );

        // Check if comic name is in similiar title database
        const q = query(collection(db, "similiar-title"), where("raw", "==", comicTitle.toLocaleLowerCase()));
        const querySnapshot = await getDocs(q);
        const isSimilarTitleExists = querySnapshot.size > 0;

        if (isSimilarTitleExists) {
          const data = querySnapshot.docs[0].data();

          if (data.ignore) {
            logger.info(`[${deviceName}] 🤝 Similiar title found, marked as DONT-SCRAPE`);
            continue;
          }

          logger.info(`[${deviceName}] 🤝 Similiar title found`);
          comicTitle = data.similiarTitle;
        }

        try {
          const response = await axios.get(`${process.env.API_ENDPOINT}/api/comics/find-one/?name=${comicTitle}`, {
            headers: { Authorization: process.env.ACCESS_TOKEN },
          });

          comicId = response.data.payload.id;
          comicChapters = response.data.payload.chapters.map((chapter) => chapter.number);
          logger.info(`[${deviceName}] Comic ${comicTitle} found in API, with ID: ${comicId}`);
        } catch (error) {
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

            await page.waitForSelector(website.elements.description);
            createComicPayload.description = await page.$eval(website.elements.description, (element) => element.textContent.trim());
            logger.info(`[${deviceName}] comic-description: Done!`);

            if (website.elements.author) {
              await page.waitForSelector(website.elements.author);
              createComicPayload.author = (await page.$eval(website.elements.author, (element) => element.textContent.trim()))
                .replace(/(pengarang|author)\s*/gi, "")
                .trim();
              logger.info(`[${deviceName}] comic-author: Done!`);
            } else {
              logger.info(`[${deviceName}] comic-author: Skipped!`);
            }

            await page.waitForSelector(website.elements.type);
            const type = await page.$eval(website.elements.type, (element) => element.textContent.trim());
            createComicPayload.type_id = TYPES[type] ?? undefined;
            logger.info(`[${deviceName}] comic-type: Done!`);

            if (website.elements.status) {
              await page.waitForSelector(website.elements.status);
              const status = (await page.$eval(website.elements.status, (element) => element.textContent.trim())).replace(
                /status\s*/gi,
                ""
              );
              createComicPayload.status_id = STATUSES[status] ?? STATUSES["ongoing"];
              logger.info(`[${deviceName}] comic-status: Done!`);
            } else {
              createComicPayload.status_id = STATUSES.ongoing;
              logger.info(`[${deviceName}] comic-status: Skipped!`);
            }

            await page.waitForSelector(website.elements.genre);
            const genres = await page.$$eval(website.elements.genre, (elements) => elements.map((element) => element.textContent.trim()));
            createComicPayload.genres = genres.map((genre) => GENRES[genre]).filter(Boolean);
            logger.info(`[${deviceName}] comic-genres: Done!`);

            const mangadexPage = await browser.newPage();

            try {
              await mangadexPage.goto("https://mangadex.org/", { timeout: 0 });
              await mangadexPage.waitForSelector(".placeholder-current");

              await mangadexPage.type(".placeholder-current", createComicPayload.name);
              await mangadexPage.waitForSelector(".manga-card-dense");

              const firstMangaCard = await mangadexPage.$(".manga-card-dense");

              if (firstMangaCard) {
                await firstMangaCard.click();
              } else {
                throw new Error("No manga found");
              }

              await mangadexPage.waitForSelector("span.text-primary", { timeout: 0 });
              createComicPayload.rating = await mangadexPage.$eval("span.text-primary", (element) => element.textContent.trim());
              logger.info(`[${deviceName}] comic-rating: Done!`);
            } catch (error) {
              logger.error(`[${deviceName}] ⚠️ comic-rating: Failed : ${error.message}`);
            } finally {
              mangadexPage.close();
            }

            await page.waitForSelector(website.elements.cover);
            const imageUrl = await page.$eval(website.elements.cover, (element) => element.src.replace(/\?.*/g, ""));

            try {
              fs.mkdirSync("./src/temp");
              await downloadFile("./src/temp", `cover`, imageUrl);
              createComicPayload.image = fs.createReadStream(`./src/temp/cover.webp`);
              logger.info(`[${deviceName}] comic-image: Done!`);
            } catch (error) {
              logger.error(`[${deviceName}] ⚠️ comic-image: Failed : ${error.message}`);
            }

            try {
              const createComicResponse = await axios.post(`${process.env.API_ENDPOINT}/api/comics`, createComicPayload, {
                headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data" },
              });

              try {
                axios.post("https://api.indexnow.org/indexnow", {
                  host: "https://komikoi.com",
                  key: "9da618746c5f47a69d45a7bdbdab8dce",
                  keyLocation: "https://komikoi.com/9da618746c5f47a69d45a7bdbdab8dce.txt",
                  urlList: [`https://komikoi.com/komik/${createComicResponse.data.payload.slug}`],
                });

                logger.info(`[${deviceName}] ⚙️ Sucessfuly send to IndexNow!`);
              } catch (error) {
                logger.error(`[${deviceName}] ⚠️ Failed to send to IndexNow : ${error.message}`);
              }

              comicId = createComicResponse.data.payload.id;
              comicTitle = createComicResponse.data.payload.name;
              logger.info(`[${deviceName}] ✅ Comic created successfuly`);
            } catch (error) {
              logger.error(`[${deviceName}] ⚠️ Failed to create comic : ${error.message}`);
              console.log(error);
              continue; // skip to next title
            } finally {
              fs.rmSync("./src/temp", { recursive: true, force: true });
            }
          } else {
            logger.warn(`[${deviceName}] ⚠️ Something went wrong, ${error.message}`);
            console.log(error);
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
                value: Number(
                  element
                    .querySelector(website.elements.chapter.text)
                    .textContent.trim()
                    .match(/chapter\s*(\d+(\.\d+)*).*/i)?.[1] ?? 0
                ),
                link: element.querySelector(website.elements.chapter.link).href,
              })),
            website
          )
        ).sort((a, b) => a.value - b.value);
        const blackListedChapters = await getDocs(query(collection(db, "blacklist-chapter"), where("comicId", "==", comicId)));
        let chaptersToSkip = comicChapters;

        if (!blackListedChapters.empty) {
          chaptersToSkip = chaptersToSkip.concat(blackListedChapters.docs[0].data().numbers);
        }

        const chaptersToScrape = availableChapters.filter((number) => {
          return !chaptersToSkip.includes(number.value);
        });

        logger.info(`[${deviceName}] Chapters found : ${chaptersToScrape.length}`);

        while (chaptersToScrape.length > 0 || failedJobs.length > 0) {
          const failedJob = failedJobs[0];
          const isPerfomingFailedJob = Boolean(failedJob);

          // Todo throw unexpected error if no alternative website
          let alternativeWebsite = isPerfomingFailedJob ? WEBSITES[failedJob.website] : null;
          let chapterToScrape = isPerfomingFailedJob ? { link: failedJob.link, value: failedJob.value } : chaptersToScrape.shift();

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
                  throw new Error(`Comic not found in alternative website: ${alternativeComicLink}`);
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
                  throw new Error(`Comic not found in alternative website: ${alternativeComicLink}`);
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

          logger.info(`[${deviceName}] Downloading images for chapter ${chapterToScrape.value}`);

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
              number: chapterToScrape.value,
              name: `Chapter ${chapterToScrape.value}`,
              images: imagesBuffer,
            };

            logger.info(`[${deviceName}] Uploading ${isPerfomingFailedJob ? failedJob.title : comicTitle} (${chapterToScrape.value})`);

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

            logger.info(`[${deviceName}] 🎉 Chapter ${chapterToScrape.value} processed in ${(Date.now() - startTime) / 1000} seconds`);
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

              const q = query(collection(db, "failed-jobs"), where("comicId", "==", comicId), where("value", "==", chapterToScrape.value));
              const querySnapshot = await getDocs(q);
              const isFailedJobExists = querySnapshot.docs.length > 0;

              if (!isFailedJobExists) {
                await addDoc(collection(db, "failed-jobs"), {
                  website: website.domain,
                  comicId: comicId,
                  title: comicTitle,
                  link: chapterToScrape.link,
                  value: chapterToScrape.value,
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
      }

      onScrapping = false;
      logger.info("✅ Scrapping finished waiting for next cron job");
    }
  }

  startScrapping();

  cron.schedule("0 */2 * * *", () => {
    if (!onScrapping) {
      startScrapping();
    }
  });
})();

process.on("unhandledRejection", (reason, promise) => {
  console.log("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.log("Uncaught Exception:", error.message, error.stack);
});
