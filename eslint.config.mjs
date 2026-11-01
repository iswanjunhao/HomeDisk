export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", localStorage: "readonly",
        fetch: "readonly", FormData: "readonly", XMLHttpRequest: "readonly",
        location: "readonly", history: "readonly", navigator: "readonly",
        console: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", alert: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn",
    },
  },
];
