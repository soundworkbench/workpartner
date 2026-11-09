import { existsSync } from "node:fs";

/** Load an installed extension and its local companion files; installed-module errors propagate. */
export async function optionalModule(file, companions = []) {
  if (![file, ...companions].every(relative => existsSync(new URL(relative, import.meta.url)))) return {};
  return import(new URL(file, import.meta.url).href);
}
