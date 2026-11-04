import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Logbook",
    identifier: "io.github.ke1ee.logbook",
    version: "0.1.0",
    description: "Turns your coding agents' transcripts into an understanding of your own systems.",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    views: {
      main: { entrypoint: "src/views/main/index.ts" },
    },
    copy: {
      "src/views/main/index.html": "views/main/index.html",
      "src/views/main/style.css": "views/main/style.css",
    },
  },
} satisfies ElectrobunConfig;
