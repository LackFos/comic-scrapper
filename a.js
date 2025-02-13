import axios from "axios";
import * as cheerio from "cheerio";

(async () => {
  const response = await axios.get("https://komiku.id/");
  const $ = cheerio.load(response.data);
  console.log($("div").text());
})();
