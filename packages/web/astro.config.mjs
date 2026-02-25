import { defineConfig } from "astro/config"

export default defineConfig({
  output: "static",
  devToolbar: {
    enabled: false,
  },
  server: {
    host: "0.0.0.0",
  },
})
