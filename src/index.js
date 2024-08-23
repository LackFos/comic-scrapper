import fs from "fs";
import inquirer from "inquirer";
import puppeteer from "puppeteer";
import { WEBSITES } from "./data/websites.js";
import { slug } from "./libs/utils.js";
import axios from "axios";

(async () => {
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

  const websiteData = WEBSITES[website];
  const websiteUrl = keyword ? `${websiteData.search}${keyword}` : websiteData.default;

  // Get the list of titles
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36"
  );

  page.goto(websiteUrl);

  console.log(`\n🔎 Fetching Comics...\n`);

  // 1) Get the list of titles
  // Wait for the element visible on DOM
  await page.waitForSelector(websiteData.elements.title.parent);

  const titles = await page.$$eval(
    websiteData.elements.title.parent,
    (elements, websiteData) =>
      elements.map((element) => ({
        text: element.querySelector(websiteData.elements.title.text).textContent.trim(),
        link: element.querySelector(websiteData.elements.title.link).href,
      })),
    websiteData
  );

  // 2 ) Get the selected comic
  const { comicTitle } = await inquirer.prompt([
    {
      name: "comicTitle",
      type: "rawlist",
      message: "Pilih komik:",
      choices: titles.map((title) => title.text),
    },
  ]);

  // 3) Open the selected comic
  const selectedComic = titles.find((comic) => comic.text === comicTitle);

  page.goto(selectedComic.link);
  await page.waitForSelector(websiteData.elements.chapter.parent);

  // 4) Get the list of chapters
  console.log(`\n🔎 Fetching Chapters...\n`);

  const chapters = await page.$$eval(
    websiteData.elements.chapter.parent,
    (elements, websiteData) =>
      elements.map((element) => {
        return {
          text: element.querySelector(websiteData.elements.chapter.text).textContent.trim(),
          link: element.querySelector(websiteData.elements.chapter.link).href,
        };
      }),
    websiteData
  );

  const { chapterTitle } = await inquirer.prompt([
    {
      name: "chapterTitle",
      type: "list",
      message: "Pilih chapter:",
      choices: chapters.map((chapter) => chapter.text),
    },
  ]);

  // 5) Open the selected chapter
  const selectedChaper = chapters.find((chapter) => chapter.text === chapterTitle);

  page.goto(selectedChaper.link, { timeout: 0 });

  console.log(`\n⬇️ Downloading Images...\n`);

  await page.waitForSelector(websiteData.elements.chapter.image);
  const images = await page.$$eval(websiteData.elements.chapter.image, (images) => images.map((image) => image.src));

  const chapterDirectory = `.src/storage/${slug(comicTitle)}/${slug(chapterTitle)}/`;

  if (!fs.existsSync(chapterDirectory)) {
    fs.mkdirSync(chapterDirectory, { recursive: true });
  }

  const downloadPromises = images.map((url, index) => {
    const failMessage = `[⚠️ Failed] to download: ${url}`;
    const successMessage = `[✅ Succeed] to download: ${url}`;

    return new Promise(async (resolve) => {
      const fileExtension = url.match(/\.\w+$/g)[0];
      const fileWriteStream = fs.createWriteStream(`${chapterDirectory}${index + 1}${fileExtension}`);

      try {
        const response = await axios.get(url, { responseType: "stream" });
        response.data.pipe(fileWriteStream);

        fileWriteStream.on("finish", () => {
          console.log(successMessage);
          resolve(successMessage);
        });

        fileWriteStream.on("error", () => {
          console.log(failMessage);
          resolve(failMessage);
        });
      } catch (error) {
        console.log(`Error: ${error}`);
        console.log(failMessage);
        resolve(failMessage);
      }
    });
  });

  await Promise.all(downloadPromises);
  console.log("\nDownload Completed!");
})();
