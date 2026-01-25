import config from "@echristian/eslint-config"

export default [
  ...config({
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
    ignores: ["public/**", "pages/**"],
  }),
  {
    files: ["src/lib/account-pool.ts"],
    rules: {
      "max-lines": ["error", { max: 1000 }],
    },
  },
]
