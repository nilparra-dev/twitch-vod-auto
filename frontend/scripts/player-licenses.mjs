import { readFile, writeFile } from "node:fs/promises";

const packages = [
  "hls.js",
  "react",
  "react-dom",
  "scheduler",
  "lucide-react",
  "@fontsource-variable/inter",
  "@fontsource-variable/inter-tight",
  "@fontsource-variable/jetbrains-mono",
];
const sections = await Promise.all(
  packages.map(
    async (name) =>
      `${name}\n${"=".repeat(name.length)}\n\n${await readFile(new URL(`../node_modules/${name}/LICENSE`, import.meta.url), "utf8")}`,
  ),
);
await writeFile(
  new URL("../../dist/player/THIRD_PARTY_LICENSES.txt", import.meta.url),
  sections.join("\n\n"),
);
