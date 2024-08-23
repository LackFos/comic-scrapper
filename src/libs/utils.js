import slugify from "slugify";

export const slug = (text) => {
  return slugify(text, { lower: true, replacement: "-" });
};
