const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "..", "public");
const output = path.join(__dirname, "..", "dist");
const configuredBackendUrl = (process.env.BACKEND_URL || "").trim();

if (!configuredBackendUrl) {
  throw new Error("Set BACKEND_URL to the deployed Tomodachi backend URL.");
}
const backendUrl = /^https?:\/\//i.test(configuredBackendUrl)
  ? configuredBackendUrl
  : `https://${configuredBackendUrl}`;

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
fs.writeFileSync(
  path.join(output, "config.js"),
  `window.TOMODACHI_API_URL = ${JSON.stringify(backendUrl.replace(/\/+$/, ""))};\n`
);
