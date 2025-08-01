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
    // Mark all dependencies as external
    if (
      id.startsWith("@actions/") ||
      id.startsWith("@docker/") ||
      id.startsWith("@buf/") ||
      id.startsWith("@connectrpc/") ||
      id.startsWith("@iarna/") ||
      id === "axios" ||
      id === "axios-retry" ||
      id === "execa" ||
      id === "child_process" ||
      id === "fs" ||
      id === "path" ||
      id === "util"
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
