import fs from "fs";
import axios from "axios";
import dotenv from "dotenv";
import pLimit from "p-limit";
import cron from "node-cron";
import inquirer from "inquirer";
import UserAgent from "user-agents";
import { WEBSITES, TYPES, STATUSES, GENRES } from "./data.js";
import { delay, downloadFile, logger, scrapper } from "./libs/utils.js";

dotenv.config();
const limit = pLimit(5);

(async () => {
  const { website } = await inquirer.prompt([
    {
      name: "website",
      type: "list",
      message: "Pilih website:",
      choices: [...Object.keys(WEBSITES), "All"],
    },
  ]);

  const websiteData = website === "All" ? Object.values(WEBSITES) : [WEBSITES[website]];

  async function startScrapping() {
    // Reset the temp folder
    if (fs.existsSync("./src/temp")) {
      fs.rmSync("./src/temp", { recursive: true, force: true });
    }

    for (const website of websiteData) {
      logger.info("Launching browser");

      const browser = await scrapper.launch({ headless: true, executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
      const page = await browser.newPage();

      const userAgent = new UserAgent();
      await page.setUserAgent(userAgent.random().toString());

      const websiteUrl = website.default;

      logger.info(`Opening page: ${websiteUrl}`);
      page.goto(websiteUrl, { timeout: 0 });

      logger.info(`Fetching titles...`);
      await page.waitForSelector(website.elements.listTitle.parent, { timeout: 0 });

      const titles = await page.$$eval(
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

      logger.info(`${titles.length} comics found.`);

      for (const title of titles) {
        website.comicDelay && (await delay(website.comicDelay));

        logger.info(`📢 Opening comic page: ${title.link}`);
        page.goto(title.link, { timeout: 0 });

        let comicId = null;
        let availableChapters = [];

        try {
          await page.waitForSelector(website.elements.title);
          const comicName = (await page.$eval(website.elements.title, (element) => element.textContent.trim())).replace(
            /(komik|comic)\s*/gi,
            ""
          );

          logger.info(`Checking if comic ${comicName} exists in the API...`);

          const response = await axios.get(`${process.env.API_ENDPOINT}/api/comics/find-one/?name=${comicName}`, {
            headers: { Authorization: process.env.ACCESS_TOKEN },
          });

          comicId = response.data.payload.id;
          availableChapters = response.data.payload.chapters.map((chapter) => chapter.number);
          logger.info(`Comic ${comicName} found. ID: ${comicId}`);
        } catch (error) {
          if (error.response?.status === 404) {
            logger.info(`Comic ${title.text} not found. Fetching metadata...`);

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
              await page.waitForSelector(website.elements.title);
              payload.name = (await page.$eval(website.elements.title, (element) => element.textContent.trim())).replace(
                /(komik|comic)\s*/gi,
                ""
              );
              logger.info(`comic-name: Done!`);

              // fetch description
              await page.waitForSelector(website.elements.description);
              payload.description = await page.$eval(website.elements.description, (element) => element.textContent.trim());
              logger.info(`comic-description: Done!`);

              // fetch author
              await page.waitForSelector(website.elements.author);
              payload.author = (await page.$eval(website.elements.author, (element) => element.textContent.trim()))
                .replace(/(pengarang|author)\s*/gi, "")
                .trim();
              logger.info(`comic-author: Done!`);

              // fetch type_id
              await page.waitForSelector(website.elements.type);
              const type = await page.$eval(website.elements.type, (element) => element.textContent.trim());
              payload.type_id = TYPES[type] ?? undefined;
              logger.info(`comic-type: Done!`);

              // fetch status_id
              await page.waitForSelector(website.elements.status);
              const status = (await page.$eval(website.elements.status, (element) => element.textContent.trim()))
                .replace(/status\s*/gi, "")
                .trim();
              payload.status_id = STATUSES[status] ?? STATUSES["ongoing"];
              logger.info(`comic-status: Done!`);

              // fetch genres
              await page.waitForSelector(website.elements.genre);
              const genres = await page.$$eval(website.elements.genre, (elements) => elements.map((element) => element.textContent.trim()));
              payload.genres = genres.map((genre) => GENRES[genre] ?? null).filter(Boolean);
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
                await page.waitForSelector(website.elements.cover);
                const imageUrl = await page.$eval(website.elements.cover, (element) => element.src.replace(/\?.*/g, ""));

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
              continue;
            } finally {
              fs.rmSync("./src/temp", { recursive: true, force: true });
            }
          } else {
            logger.warn(`⚠️ Something went wrong`);
            console.log(error);
            process.exit(1);
          }
        }

        await page.waitForSelector(website.elements.chapter.parent);

        const chapterNumbers = (
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
        ).sort((a, b) => Number(a.value) - Number(b.value));

        logger.info(`Fetching Chapters`);

        const chaptersToScrape = chapterNumbers.filter((number) => {
          return !availableChapters.includes(number.value);
        });

        for (const chapter of chaptersToScrape) {
          try {
            fs.mkdirSync("./src/temp");

            website.chapterDelay && (await delay(website.chapterDelay));
            const startTime = Date.now();

            logger.info(`📢 Opening chapter page: ${chapter.link}`);
            page.goto(chapter.link, { timeout: 0 });

            logger.info(`Downloading images for chapter ${chapter.value}`);

            await page.waitForSelector(website.elements.chapter.image, { timeout: 0 });
            const images = await page.$$eval(website.elements.chapter.image, (images) => images.map((image) => image.src));

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

            const files = fs.readdirSync("./src/temp");

            const payload = {
              comic_id: comicId,
              number: chapter.value,
              name: `Chapter ${chapter.value}`,
              images: files.map((file) => {
                const filePath = `./src/temp/${file}`;
                return fs.createReadStream(filePath);
              }),
            };

            logger.info(`Uploading chapter ${chapter.value} data...`);

            await axios.post(`${process.env.API_ENDPOINT}/api/chapters`, payload, {
              headers: { Authorization: process.env.ACCESS_TOKEN, "Content-Type": "multipart/form-data", Accept: "application/json" },
            });

            const endTime = Date.now();
            logger.info(`🎉 Chapter ${chapter.value} processed in ${(endTime - startTime) / 1000} seconds`);
          } catch (error) {
            logger.error(`⚠️ Failed to process chapter ${chapter.link}, ${error.message}`);
            continue;
          } finally {
            fs.rmSync("./src/temp", { recursive: true, force: true });
          }
        }
      }

      await browser.close();
    }
  }

  startScrapping();

  cron.schedule("0 */3 * * *", startScrapping);
})();
