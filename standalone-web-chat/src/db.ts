import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set (see .env.example)");
}

// Bounded pool: a slow database or a runaway query must not hang the process.
export const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

// An error on an idle client would otherwise crash the process.
pool.on("error", (err) => {
  console.error("unexpected idle pg client error", err.message);
});
