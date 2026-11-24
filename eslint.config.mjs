// Mirrors the checks the community directory runs, so `npm run lint`
// tells us exactly what the review will say before we publish.
import obsidian from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

const minAppVersion = "1.8.7";

const config = obsidian.configs.recommended.map((entry) => {
  if (!entry.rules) return entry;
  const rules = {};
  for (const [name, value] of Object.entries(entry.rules)) {
    if (/unsupported-api|prefer-get-language/.test(name)) {
      rules[name] = Array.isArray(value) ? [value[0], { minAppVersion }] : [value, { minAppVersion }];
    } else {
      rules[name] = value;
    }
  }
  return { ...entry, rules };
});

export default [
  ...config,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
  },
  { ignores: ["main.js", "node_modules/**", "test/**"] },
];
