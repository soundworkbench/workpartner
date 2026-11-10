import { existsSync } from "node:fs";

/** Load an installed extension and its local companion files; installed-module errors propagate. */
export async function optionalModule(file, companions = []) {
  if (![file, ...companions].every(relative => existsSync(new URL(relative, import.meta.url)))) return {};
  return import(new URL(file, import.meta.url).href);
}

/** Load a trusted local organization extension only when explicitly configured. */
export async function gatewayExtension(organization, dependencies) {
  const module = organization.extensions.gatewayModule;
  if (!module) return null;
  const { resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { createGatewayExtension } = await import(pathToFileURL(resolve(organization.directory, module)).href);
  return createGatewayExtension(dependencies);
}
