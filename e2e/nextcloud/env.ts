import { readFileSync } from "node:fs";

export const NC_VERSION = process.env.NC_VERSION ?? "33";
export const NC_URL = "http://127.0.0.1:8099";
export const SERVICE_PORT = 4400;
export const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
export const CONTAINER = "ncmail-nc-e2e";
export const ADMIN = { user: "admin", password: "ncmail-e2e-admin-pw" }; // a throwaway test instance
export const APP_DIR = new URL("../../integration/nextcloud-app/ncmail", import.meta.url).pathname;
/** The app's own version, from appinfo/info.xml. */
export const APP_VERSION = readFileSync(`${APP_DIR}/appinfo/info.xml`, "utf8").match(/<version>([^<]+)<\/version>/)![1]!;
