import fs from "fs";
import axios from "axios";
import sharp from "sharp";
import dotenv from "dotenv";
import winston from "winston";
import puppeteer from "puppeteer-extra";
import { Logtail } from "@logtail/node";
import { LogtailTransport } from "@logtail/winston";
import pluginStealth from "puppeteer-extra-plugin-stealth";

dotenv.config();

puppeteer.use(pluginStealth());
export const scrapper = puppeteer;

const logtail = new Logtail(process.env.LOGTAIL_SOURCE_TOKEN);
export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new LogtailTransport(logtail), new winston.transports.Console()],
});

export const delay = (ms) => {
  const randomNumber = Math.random();

  console.log(`⌛ Delay for ${ms + randomNumber}ms...`);

  return new Promise((resolve) =>
    setTimeout(() => {
      console.log(`⌛ Delay finished`);
      return resolve();
    }, ms + randomNumber)
  );
};

export const downloadFile = async (targetDirectory, filename, url) => {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios.get(url, { responseType: "arraybuffer" });

      if (!response.headers["content-type"].startsWith("image")) {
        resolve(true);
      }

      const metadata = await sharp(response.data).metadata();
      const isImageToBigForWebp = metadata.width > 16383 || metadata.height > 16383;

      const compressedImage = isImageToBigForWebp
        ? await sharp(response.data).jpeg({ quality: 80 }).toBuffer()
        : await sharp(response.data).webp({ quality: 80 }).toBuffer();

      const outputFilename = `${filename}.${isImageToBigForWebp ? "jpeg" : "webp"}`;
      fs.writeFileSync(`${targetDirectory}/${outputFilename}`, compressedImage);

      logger.info(`Success to download: ${url}`);
      resolve(true);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        const customError = new Error(`💔 Broken file detected ${url}`);
        customError.isCritical = true;
        reject(customError);
      } else {
        const customError = new Error(`${error} ${url}`);
        customError.isCritical = true;
        reject(customError);
      }
    }
  });
};
