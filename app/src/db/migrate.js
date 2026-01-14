import fs from "fs";
import pg from "pg";

const { Client } = pg;

async function main() {
  const sql = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log("✅ Migration applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
