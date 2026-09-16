// Assembles public/ from src/: app.js = core.js (export stripped) + app.src.js; copies css and html.
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
mkdirSync("public", {recursive: true});
const core = readFileSync("src/core.js", "utf8").replace(/\nexport default CORE;\s*$/, "\n");
const app = readFileSync("src/app.src.js", "utf8");
writeFileSync("public/app.js", core + "\n" + app);
writeFileSync("public/app.css", readFileSync("src/app.css", "utf8"));
writeFileSync("public/index.html", readFileSync("src/index.html", "utf8"));
writeFileSync("public/_headers", readFileSync("src/_headers", "utf8"));
console.log("built public/app.js (" + (core.length + app.length) + " bytes)");
