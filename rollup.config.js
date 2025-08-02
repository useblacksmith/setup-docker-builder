import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/main.ts",
  output: {
    dir: "dist",
    entryFileNames: "[name].bundle.mjs",
    format: "es",
  },
  external: (id) => {
    // Only mark Node.js built-in modules as external
    if (
      id === "child_process" ||
      id === "fs" ||
      id === "path" ||
      id === "util" ||
      id === "os" ||
      id === "crypto" ||
      id === "stream" ||
      id === "http" ||
      id === "https" ||
      id === "net" ||
      id === "tls" ||
      id === "url" ||
      id === "assert" ||
      id === "buffer" ||
      id === "events" ||
      id === "querystring" ||
      id === "string_decoder" ||
      id === "zlib"
    ) {
      return true;
    }
    return false;
  },
  plugins: [
    nodeResolve({
      preferBuiltins: true,
      extensions: [".js", ".ts"],
    }),
    typescript({
      tsconfig: false,
      compilerOptions: {
        module: "ES2020",
        target: "ES2020",
        moduleResolution: "node",
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true,
        strict: false,
      },
    }),
  ],
};
