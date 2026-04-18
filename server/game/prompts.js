const fs = require("fs");

function loadPrompts(filePath, fallback) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const prompts = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return prompts.length ? prompts : fallback;
  } catch (error) {
    return fallback;
  }
}

function shuffle(list) {
  const items = list.slice();
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = items[i];
    items[i] = items[j];
    items[j] = temp;
  }
  return items;
}

function getPromptOptions(prompts, count) {
  if (!prompts.length) return [];
  const shuffled = shuffle(prompts);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

module.exports = {
  loadPrompts,
  getPromptOptions
};
