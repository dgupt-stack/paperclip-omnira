import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] || "bun-darwin-arm64";
const outputPath = process.argv[3] || join(appDir, "..", "build", `paperclip-entity-${target}`);

await import("./generate-embedded-assets.mjs");
await mkdir(dirname(outputPath), { recursive: true });

const pgliteEmbeddedFilePlugin = {
  name: "pglite-embedded-extension-files",
  setup(build) {
    build.onLoad({ filter: /@electric-sql\/pglite\/dist\/index\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      const needle = "async function ke(e){if(Re){";
      if (!contents.includes(needle)) {
        throw new Error("The installed PGlite bundle loader no longer matches the standalone patch");
      }
      const bunLoader = [
        "async function ke(e){",
        "if(globalThis.Bun){",
        "const p=e instanceof URL&&e.protocol===\"file:\"?e.pathname:String(e);",
        "const f=Bun.file(p);",
        "if(await f.exists()){",
        "const d=new DecompressionStream(\"gzip\");",
        "return new Response(f.stream().pipeThrough(d)).blob();",
        "}",
        "}",
        "if(Re){",
      ].join("");
      contents = contents.replace(needle, bunLoader);
      return { contents, loader: "js" };
    });
  },
};

const unusedRuntimeStubsPlugin = {
  name: "strict-entity-unused-runtime-stubs",
  setup(build) {
    build.onResolve({ filter: /^vite$/ }, () => ({ path: "vite", namespace: "strict-entity-stub" }));
    build.onResolve(
      { filter: /^@embedded-postgres\// },
      (args) => ({ path: args.path, namespace: "strict-entity-stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "strict-entity-stub" }, (args) => ({
      contents: args.path === "vite"
        ? "export async function createServer(){throw new Error('Vite is disabled in strict Entity-only mode')}"
        : "export default {};",
      loader: "js",
    }));
    build.onLoad(
      { filter: /jsdom\/lib\/jsdom\/living\/helpers\/style-rules\.js$/ },
      async (args) => {
        let contents = await readFile(args.path, "utf8");
        const stylesheetPath = join(dirname(args.path), "../../browser/default-stylesheet.css");
        const stylesheet = await readFile(stylesheetPath, "utf8");
        const needle = [
          "const defaultStyleSheet = fs.readFileSync(",
          "  path.resolve(__dirname, \"../../browser/default-stylesheet.css\"),",
          "  { encoding: \"utf-8\" }",
          ");",
        ].join("\n");
        if (!contents.includes(needle)) {
          throw new Error("The installed jsdom stylesheet loader no longer matches the standalone patch");
        }
        contents = contents.replace(
          needle,
          `const defaultStyleSheet = ${JSON.stringify(stylesheet)};`,
        );
        return { contents, loader: "js" };
      },
    );
    build.onLoad(
      { filter: /@paperclipai\/server\/dist\/middleware\/logger\.js$/ },
      async (args) => {
        let contents = await readFile(args.path, "utf8");
        const logPreludeStart = contents.indexOf("const logDir = resolveServerLogDir();");
        const loggerExport = contents.indexOf("export const logger = pino(");
        const transportStart = contents.indexOf("}, pino.transport({", loggerExport);
        const httpLoggerExport = contents.indexOf("export const httpLogger", transportStart);
        const transportEnd = contents.lastIndexOf("));", httpLoggerExport);
        if (
          logPreludeStart < 0
          || loggerExport < 0
          || transportStart < 0
          || httpLoggerExport < 0
          || transportEnd < transportStart
        ) {
          throw new Error("Paperclip logger no longer matches the strict Entity-only patch");
        }
        // Do not create a log directory or launch pino-pretty workers. Omnira
        // captures stdout, and strict mode must not depend on local log files.
        contents = contents.slice(0, logPreludeStart) + contents.slice(loggerExport);
        const shiftedLoggerExport = contents.indexOf("export const logger = pino(");
        const shiftedTransportStart = contents.indexOf("}, pino.transport({", shiftedLoggerExport);
        const shiftedHttpExport = contents.indexOf("export const httpLogger", shiftedTransportStart);
        const shiftedTransportEnd = contents.lastIndexOf("));", shiftedHttpExport);
        contents = contents.slice(0, shiftedTransportStart)
          + "}, pino.destination(1));"
          + contents.slice(shiftedTransportEnd + 3);
        return { contents, loader: "js" };
      },
    );
    build.onLoad(
      { filter: /@paperclipai\/server\/dist\/version\.js$/ },
      () => ({
        contents: [
          "export function parseGitDescribeVersion(){return null}",
          "export function resolveServerVersion(){return '2026.722.0-entity.1'}",
          "export const serverVersion = resolveServerVersion();",
        ].join("\n"),
        loader: "js",
      }),
    );
    build.onLoad(
      { filter: /@paperclipai\/adapter-codex-local\/dist\/server\/codex-auth-merge-scripts\.js$/ },
      async (args) => {
        const sourceDir = dirname(args.path);
        const [extractScript, decisionScript] = await Promise.all([
          readFile(join(sourceDir, "codex-auth-merge-extract.sh")),
          readFile(join(sourceDir, "codex-auth-merge-decision.cjs")),
        ]);
        return {
          contents: [
            "import path from 'node:path';",
            "import { shellQuote } from '@paperclipai/adapter-utils/ssh';",
            "export const CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME='codex-auth-merge-extract.sh';",
            "export const CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME='codex-auth-merge-decision.cjs';",
            `const extractBytes=Buffer.from(${JSON.stringify(extractScript.toString("base64"))},'base64');`,
            `const decisionBytes=Buffer.from(${JSON.stringify(decisionScript.toString("base64"))},'base64');`,
            "export function buildCodexAuthInboundProvision(){return{stageFiles:[{name:CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME,contents:extractBytes},{name:CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME,contents:decisionBytes}],extractCommand:({assetTarPath,assetDir,runtimeRootDir})=>`sh ${shellQuote(path.posix.join(runtimeRootDir,CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME))} ${shellQuote(assetDir)} ${shellQuote(assetTarPath)}`}}",
          ].join("\n"),
          loader: "js",
        };
      },
    );
  },
};

const result = await Bun.build({
  entrypoints: [join(appDir, "entity-only-server.mjs")],
  compile: {
    target,
    outfile: outputPath,
  },
  minify: true,
  sourcemap: "none",
  plugins: [pgliteEmbeddedFilePlugin, unusedRuntimeStubsPlugin],
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ target, outputPath }));
}
