// Ports/credentials of the throwaway stack in testing/docker-compose.yml
export const API_URL = process.env.TEST_API_URL ?? "http://127.0.0.1:4100";
export const IMAP_HOST = "127.0.0.1";
export const IMAP_PORT = 11143;
export const SMTP_PORT = 11025;
export const MAILPIT_URL = "http://127.0.0.1:18025";
export const TEST_PASSWORD = "test";
/** u01@example.test ... u20@example.test: every test file uses its own user so files can run in parallel. */
export const user = (n: number) => `u${String(n).padStart(2, "0")}@example.test`;
