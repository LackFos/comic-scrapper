export const WEBSITES = {
  "komiku.id": {
    default: "https://komiku.id/pustaka",
    search: "https://komiku.id/?post_type=manga&s=",
    elements: {
      title: {
        parent: ".kan",
        text: "h3",
        link: "a",
      },
      chapter: {
        parent: "td.judulseries",
        text: "a span",
        link: "a",
        image: ".ww",
      },
    },
  },
};
