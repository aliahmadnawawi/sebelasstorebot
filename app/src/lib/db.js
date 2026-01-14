import pg from "pg";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function getOrCreateUser(telegramId) {
  const r = await pool.query(
    `insert into users (telegram_id) values ($1)
     on conflict (telegram_id) do update set telegram_id=excluded.telegram_id
     returning *`,
    [telegramId]
  );
  return r.rows[0];
}
