import fs from "fs";
import dotenv from "dotenv";
import inquirer from "inquirer";
import { collection, onSnapshot } from "firebase/firestore";
import connectToDatabase from "./connectToDatabase.js";
import { WEBSITES } from "./data.js";
import { scrapper } from "./libs/utils.js";

// Load .env file
dotenv.config();

const db = await connectToDatabase();

// Keep track of failed jobs
let failedJobs = [];

onSnapshot(collection(db, "failed-jobs"), (snapshot) => {
  failedJobs = snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter((job) => job.onRetry === false || job.aborted === false);
});

(async () => {
  if (fs.existsSync("./src/temp")) {
    fs.rmSync("./src/temp", { recursive: true, force: true });
  }

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

  console.log("\nLaunching browser...");
  const browser = await scrapper.launch({ headless: false });
  const page = await browser.newPage();

  const website = WEBSITES[selectedWebsite];
  const websiteUrl = keyword ? `${website.search}${keyword}` : website.default;

  console.log(`Opening website: ${websiteUrl}`);
  page.goto(websiteUrl, { timeout: 0 });

  console.log(`Fetching titles...\n`);
  const titleElement = keyword && websiteData.searchElements?.listTitle ? website.searchElements.listTitle : website.elements.listTitle;
  await page.waitForSelector(titleElement.parent, { timeout: 0 }); // Wait for the page to load
  const availableTitles = await page.$$eval(
    titleElement.parent,
    (elements, titleElement) =>
      elements.map((element) => ({
        text: element.querySelector(titleElement.text).textContent.trim(),
        link: element.querySelector(titleElement.link).href,
      })),
    titleElement
  );

  const { selectedTitle, scrapeMode } = await inquirer.prompt([
    {
      name: "selectedTitle",
      type: "rawlist",
      message: "Pilih komik:",

      choices: availableTitles.map((title) => title.text),
    },
    {
      name: "scrapeMode",
      type: "list",
      message: "Pilih mode:",
      choices: ["Auto", "Single"],
    },
  ]);

  const selectedComic = titles.find((comic) => comic.text === selectedTitle);
  website.comicDelay && (await delay(website.comicDelay));
})();
