// Gives every mail account that has no owner to a Nextcloud user: pnpm adopt-accounts <nextcloud-user>
import pg from "pg";
const user = process.argv[2];
if (!user) { console.error("Usage: pnpm adopt-accounts <nextcloud-user>"); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query("update accounts set owner = $1 where owner = '' returning name, email", [user]);
console.log(r.rows.length ? `Now owned by ${user}:\n${r.rows.map((a) => `  ${a.name} <${a.email}>`).join("\n")}` : "No unowned accounts.");
await c.end();
